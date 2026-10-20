/**
 * Button Lab — design sandbox for the candidate primary-button treatments.
 * Route: /redesign/button-lab (expo-router file-based).
 *
 * v2 rebuild — implements the craft-pass recipes EXACTLY as spec'd in:
 *   docs/design/explorations/2026-08-06-button-background-marriage-v2.md  (A/B/C/C-teal/D)
 *   docs/design/explorations/2026-08-06-opal-button-study.md              (OPAL)
 *
 * v2 craft moves (why v1 read flat): sweep fills never flat color · 1px inner
 * top rim · bottom floor shade · two-stage bloom (wide soft halo on the outer
 * wrapper + tight bright halo on a middle wrapper) · structural 1px border ·
 * press/disabled mutate light and hue on the SAME object (gradient, rim, floor
 * and geometry survive every state).
 *
 * Shared structure per treatment:
 *   outer View (radius + wide halo, no clip)
 *   → middle View (tight halo)
 *   → inner Animated.View (radius, overflow hidden, borderWidth 1)
 *   → fill gradient → 1pt top rim → floor gradient → label.
 *
 * The root Stack (app/_layout.tsx) mounts a global StarField behind screens
 * with contentStyle transparent, so this screen paints NO background — the
 * cosmos shows through, which is the whole point of the comparison.
 */

import React, { useState } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type TextStyle,
  type ViewStyle,
  type ColorValue,
} from 'react-native';
import Animated, {
  Easing,
  interpolate,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import tokens from '@/src/theme/tokens';
import { ambientGlow } from '@/src/theme/glow';
import { Card } from '@/src/components/ui/Card';
import { haptic } from '@/src/utils/haptics';
import { useReduceTransparency } from '@/hooks/use-reduce-transparency';

// ─── Shared press constants (mirrors PrimaryPill) ────────────────────────────

const QUICK_MS = tokens.motion.quick.duration; // 140ms
const QUICK_EASING = Easing.bezier(0.4, 0, 0.2, 1);

const FLOOR_HEIGHT = 16;

// ─── Non-token rgba values from the v2 / opal exploration docs ───────────────
// FIXME(nex-56): design-exploration recipe values with no token equivalents —
// hardcoded by design while the treatments were being compared. The owner
// picked OPAL (2026-08-06); its recipe is ported into the real button kit in
// PR #377. The remaining palettes stay here as exploration records.
// A — Starlight.
const A_FILL = ['#FFFFFF', '#F7F9FC', '#DFE5F0'] as const;
const A_FILL_PRESSED = '#E4E8F0';
const A_FILL_DISABLED = ['rgba(255,255,255,0.22)', 'rgba(255,255,255,0.13)'] as const;
const A_RIM = 'rgba(255,255,255,0.90)';
const A_RIM_PRESSED = 'rgba(255,255,255,0.60)';
const A_RIM_DISABLED = 'rgba(255,255,255,0.20)';
const A_BORDER_DISABLED = 'rgba(255,255,255,0.18)';
const A_FLOOR = 'rgba(6,6,12,0.10)';
const A_HALO_WIDE = 'rgba(255,255,255,0.11)';
const A_HALO_TIGHT = 'rgba(198,220,255,0.30)'; // cool-tinted: starlight, not fog
const A_LABEL_DISABLED = 'rgba(255,255,255,0.45)';
// B — Struck gold.
const B_FILL = ['#B6873F', '#E5BA6E', '#F5D89A', '#E5BA6E', '#A87C3B'] as const;
const B_FILL_LOCS = [0, 0.28, 0.5, 0.72, 1] as const;
const B_FILL_PRESSED = ['#8E6B31', '#C79A50', '#8E6B31'] as const;
const B_FILL_DISABLED = ['rgba(229,186,110,0.20)', 'rgba(229,186,110,0.12)'] as const;
const B_SHADE_TOP = 'rgba(255,255,255,0.16)';
const B_SHADE_BOTTOM = 'rgba(74,48,12,0.16)';
const B_RIM = 'rgba(255,246,222,0.70)';
const B_RIM_PRESSED = 'rgba(255,246,222,0.40)';
const B_RIM_DISABLED = 'rgba(255,246,222,0.18)';
const B_BORDER = 'rgba(255,240,205,0.45)';
const B_HALO_WIDE = 'rgba(229,186,110,0.30)';
const B_HALO_TIGHT = 'rgba(229,186,110,0.24)';
const B_LABEL_DISABLED = 'rgba(255,255,255,0.38)';
// C — Glass (gold + teal tones).
const C_WASH = ['rgba(229,186,110,0.20)', 'rgba(229,186,110,0.10)', 'rgba(95,224,234,0.06)'] as const;
const C_WASH_PRESSED = ['rgba(229,186,110,0.30)', 'rgba(229,186,110,0.16)', 'rgba(95,224,234,0.10)'] as const;
const C_WASH_LOCS = [0, 0.55, 1] as const;
const C_WASH_DISABLED = 'rgba(229,186,110,0.05)';
const C_BORDER_REST = 'rgba(229,186,110,0.50)';
const C_BORDER_PRESSED = 'rgba(242,208,138,0.80)'; // goldBright @ 80%
const C_BORDER_DISABLED = 'rgba(255,255,255,0.12)';
const C_RIM = 'rgba(255,255,255,0.30)';
const C_RIM_PRESSED = 'rgba(255,255,255,0.45)';
const C_RIM_DISABLED = 'rgba(255,255,255,0.10)';
const C_FLOOR = 'rgba(0,0,0,0.22)';
const C_HALO_TIGHT = 'rgba(229,186,110,0.20)';
const C_LABEL_DISABLED = 'rgba(255,255,255,0.32)';
const C_OPAQUE_TINT = 'rgba(20,17,12,0.96)'; // Reduce Transparency base (v2)
const CT_WASH = ['rgba(95,224,234,0.18)', 'rgba(95,224,234,0.08)', 'rgba(255,255,255,0.05)'] as const;
// C-teal pressed/disabled aren't tabled — interpreted with C's "brighten on
// press / drain hue when disabled" rules (same deltas as the gold wash).
const CT_WASH_PRESSED = ['rgba(95,224,234,0.28)', 'rgba(95,224,234,0.14)', 'rgba(255,255,255,0.08)'] as const;
const CT_WASH_DISABLED = 'rgba(95,224,234,0.05)';
const CT_BORDER_REST = 'rgba(95,224,234,0.50)';
const CT_BORDER_PRESSED = 'rgba(127,232,240,0.80)'; // tealBright @ 80%
const CT_RIM = 'rgba(220,250,255,0.34)';
const CT_HALO_WIDE = 'rgba(95,224,234,0.24)';
const CT_HALO_TIGHT = 'rgba(95,224,234,0.18)';
// OPAL — bloom-in-the-middle sweep. v2.1 retune after owner feedback ("too loud
// and noisy"): Opal's real sweep is DIM — hue does the work, luminance stays
// near the background. Alphas cut ~2/3 from the study's first draft; the core
// is a warm gleam, not white-hot. Halos and edge quieted to match.
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
// OPAL quiet light: Opal's pill carries no loud glow — halo alphas well under
// the card's ambientGlow (0.28) so the button sits calm on the field.
const OPAL_HALO_WIDE = { shadowColor: 'rgba(229,186,110,0.13)', shadowRadius: 28, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 1 } as const;
const OPAL_HALO_TIGHT = 'rgba(229,186,110,0.09)';
const OPAL_BORDER_REST = 'rgba(229,186,110,0.32)';
const OPAL_BORDER_PRESSED = 'rgba(242,208,138,0.50)';
const OPAL_RIM = 'rgba(255,255,255,0.18)';
const OPAL_RIM_PRESSED = 'rgba(255,255,255,0.28)';
const OPAL_FLOOR = 'rgba(0,0,0,0.16)';
// D — Ghost.
const D_FILL = ['rgba(255,255,255,0.10)', 'rgba(255,255,255,0.035)', 'rgba(255,255,255,0.06)'] as const;
const D_FILL_PRESSED = ['rgba(255,255,255,0.16)', 'rgba(255,255,255,0.08)', 'rgba(255,255,255,0.10)'] as const;
const D_FILL_LOCS = [0, 0.55, 1] as const;
const D_RIM = 'rgba(255,255,255,0.22)';
const D_RIM_PRESSED = 'rgba(255,255,255,0.34)';
const D_BORDER_PRESSED = 'rgba(255,255,255,0.40)'; // = Card's BORDER_PRESS
const D_CONTACT = 'rgba(0,0,0,0.35)';

// ─── Halo helpers (iOS shadow props / Android elevation fallback) ────────────

function iosShadow(color: string, radius: number, offsetY: number): ViewStyle {
  return Platform.select<ViewStyle>({
    ios: {
      shadowColor: color,
      shadowRadius: radius,
      shadowOffset: { width: 0, height: offsetY },
      shadowOpacity: 1,
    },
    android: { elevation: 4 },
  }) as ViewStyle;
}

const HALO_OFF: ViewStyle = Platform.select<ViewStyle>({
  ios: { shadowOpacity: 0 },
  android: { elevation: 0 },
}) as ViewStyle;

// ─── Types ────────────────────────────────────────────────────────────────────

type Treatment = 'OPAL' | 'A' | 'B' | 'C' | 'C-TEAL' | 'D';

type LabButtonProps = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  compact?: boolean;
  /** Inside a Card: C and D switch to radii.lg so corners match the card. */
  inCard?: boolean;
  /** Full-width (in-card context) vs centered standalone pill. */
  fullWidth?: boolean;
};

// ─── Shared shell: outer wide halo → middle tight halo → inner clipped body ──

type LabShellProps = {
  label: string;
  onPress: () => void;
  disabled: boolean;
  height: number;
  radius: number;
  padH: number;
  minWidth?: number;
  fullWidth?: boolean;
  /** Wide halo on the outer wrapper (or D's contact shadow). */
  outerHalo: ViewStyle;
  /** Tight halo on the middle wrapper; swapped to tightHaloPressed on press. */
  tightHalo?: ViewStyle;
  tightHaloPressed?: ViewStyle;
  borderRest: string;
  borderPressed: string;
  borderDisabled: string;
  /** 1pt inner top rim; omit rimRest for no rim. */
  rimRest?: string;
  rimPressed?: string;
  rimDisabled?: string;
  /** Fill layers, bottom → top. pressed crossfades in over rest. */
  fillRest: React.ReactNode;
  fillPressed?: React.ReactNode;
  fillDisabled?: React.ReactNode;
  /** Extra static layer above the fill (B's shade overlay). */
  overlay?: React.ReactNode;
  floorColor?: string; // bottom shade, kept in every state
  labelStyle: TextStyle;
  labelColor: string;
  labelDisabledColor: string;
  hapticKey: 'buttonPrimary' | 'buttonSecondary';
  pressedScale: number;
};

function LabShell({
  label,
  onPress,
  disabled,
  height,
  radius,
  padH,
  minWidth,
  fullWidth = false,
  outerHalo,
  tightHalo,
  tightHaloPressed,
  borderRest,
  borderPressed,
  borderDisabled,
  rimRest,
  rimPressed,
  rimDisabled,
  fillRest,
  fillPressed,
  fillDisabled,
  overlay,
  floorColor,
  labelStyle,
  labelColor,
  labelDisabledColor,
  hapticKey,
  pressedScale,
}: LabShellProps) {
  const pressProgress = useSharedValue(0);
  // React-side pressed flag only for the tight-halo radius swap (shadowRadius
  // isn't UI-thread animatable; the 140ms color/scale work stays on the SV).
  const [pressed, setPressed] = useState(false);

  const innerAnim = useAnimatedStyle(() => ({
    borderColor: interpolateColor(pressProgress.value, [0, 1], [borderRest, borderPressed]),
    transform: [{ scale: interpolate(pressProgress.value, [0, 1], [1, pressedScale]) }],
  }));
  const pressedFillAnim = useAnimatedStyle(() => ({
    opacity: pressProgress.value,
  }));
  const rimAnim = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      pressProgress.value, [0, 1], [rimRest ?? 'transparent', rimPressed ?? rimRest ?? 'transparent'],
    ),
  }));

  function handlePressIn() {
    if (disabled) return;
    setPressed(true);
    pressProgress.value = withTiming(1, { duration: QUICK_MS, easing: QUICK_EASING });
    haptic(hapticKey);
  }
  function handlePressOut() {
    if (disabled) return;
    setPressed(false);
    pressProgress.value = withTiming(0, { duration: QUICK_MS, easing: QUICK_EASING });
  }

  const middleHalo = disabled ? HALO_OFF : pressed && tightHaloPressed ? tightHaloPressed : tightHalo;

  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      style={[
        styles.shellOuter,
        { borderRadius: radius },
        fullWidth && styles.fullWidth,
        disabled ? HALO_OFF : outerHalo,
      ]}
    >
      <View style={[{ borderRadius: radius }, middleHalo]}>
        <Animated.View
          style={[
            styles.shellInner,
            { borderRadius: radius, height, paddingHorizontal: padH },
            minWidth ? { minWidth } : null,
            disabled ? { borderColor: borderDisabled } : innerAnim,
          ]}
        >
          {/* Fill (rest + crossfading pressed layer; disabled swaps the fill). */}
          {disabled ? fillDisabled ?? fillRest : fillRest}
          {!disabled && fillPressed && (
            <Animated.View
              style={[StyleSheet.absoluteFill, pressedFillAnim]}
              pointerEvents="none"
            >
              {fillPressed}
            </Animated.View>
          )}
          {overlay}
          {/* 1pt inner top rim — fakes the bevel catching overhead light. */}
          {rimRest && (
            <Animated.View
              style={[
                styles.rim,
                disabled ? { backgroundColor: rimDisabled ?? rimRest } : rimAnim,
              ]}
              pointerEvents="none"
            />
          )}
          {/* Floor — bottom shade opposite the rim; survives every state. */}
          {floorColor && (
            <LinearGradient
              colors={['transparent', floorColor]}
              locations={[0, 1]}
              start={{ x: 0.5, y: 0 }}
              end={{ x: 0.5, y: 1 }}
              style={styles.floor}
              pointerEvents="none"
            />
          )}
          <Text
            style={[labelStyle, { color: disabled ? labelDisabledColor : labelColor }]}
            numberOfLines={1}
          >
            {label}
          </Text>
        </Animated.View>
      </View>
    </Pressable>
  );
}

// ─── Gradient shorthands ─────────────────────────────────────────────────────

// expo-linear-gradient types colors/locations as non-empty tuples.
type GradStops = {
  colors: readonly [ColorValue, ColorValue, ...ColorValue[]];
  locations?: readonly [number, number, ...number[]];
};

function VFill({ colors, locations }: GradStops) {
  return (
    <LinearGradient
      colors={colors}
      locations={locations}
      start={{ x: 0.5, y: 0 }}
      end={{ x: 0.5, y: 1 }}
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
    />
  );
}

function HFill({ colors, locations }: GradStops) {
  return (
    <LinearGradient
      colors={colors}
      locations={locations}
      start={{ x: 0, y: 0.5 }}
      end={{ x: 1, y: 0.5 }}
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
    />
  );
}

function DiagFill({ colors, locations }: GradStops) {
  return (
    <LinearGradient
      colors={colors}
      locations={locations}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
    />
  );
}

// ─── A — Starlight Pill (hero, exactly one per screen) ───────────────────────

function StarlightPill({ label, onPress, disabled = false, fullWidth = false }: LabButtonProps) {
  return (
    <LabShell
      label={label}
      onPress={onPress}
      disabled={disabled}
      height={56}
      radius={tokens.radii.full}
      padH={tokens.spacing.xl} // 32
      minWidth={200}
      fullWidth={fullWidth}
      outerHalo={iosShadow(A_HALO_WIDE, 40, 0)}
      tightHalo={iosShadow(A_HALO_TIGHT, 14, 2)}
      tightHaloPressed={iosShadow(A_HALO_TIGHT, 8, 2)}
      borderRest="#FFFFFF"
      borderPressed="#FFFFFF"
      borderDisabled={A_BORDER_DISABLED}
      rimRest={A_RIM}
      rimPressed={A_RIM_PRESSED}
      rimDisabled={A_RIM_DISABLED}
      fillRest={<VFill colors={A_FILL} locations={[0, 0.5, 1]} />}
      fillPressed={<View style={[StyleSheet.absoluteFill, { backgroundColor: A_FILL_PRESSED }]} />}
      fillDisabled={<VFill colors={A_FILL_DISABLED} />}
      floorColor={A_FLOOR}
      labelStyle={styles.labelHero17}
      labelColor={tokens.color.textInverse}
      labelDisabledColor={A_LABEL_DISABLED}
      hapticKey="buttonPrimary"
      pressedScale={0.97}
    />
  );
}

// ─── B — Struck-Gold Pill (override-only: breaks the ≤5% gold budget) ────────

function StruckGoldPill({ label, onPress, disabled = false, compact = false, fullWidth = false }: LabButtonProps) {
  return (
    <LabShell
      label={label}
      onPress={onPress}
      disabled={disabled}
      height={compact ? 44 : 56}
      radius={tokens.radii.full}
      padH={compact ? tokens.spacing.lg : tokens.spacing.xl}
      fullWidth={fullWidth}
      outerHalo={iosShadow(B_HALO_WIDE, 34, 10)}
      tightHalo={iosShadow(B_HALO_TIGHT, 12, 3)}
      tightHaloPressed={iosShadow(B_HALO_TIGHT, 6, 3)}
      borderRest={B_BORDER}
      borderPressed={B_BORDER}
      borderDisabled={B_BORDER}
      rimRest={B_RIM}
      rimPressed={B_RIM_PRESSED}
      rimDisabled={B_RIM_DISABLED}
      fillRest={<HFill colors={B_FILL} locations={B_FILL_LOCS} />}
      fillPressed={<HFill colors={B_FILL_PRESSED} locations={[0, 0.5, 1]} />}
      fillDisabled={<HFill colors={B_FILL_DISABLED} />}
      overlay={
        <LinearGradient
          colors={[B_SHADE_TOP, 'transparent', B_SHADE_BOTTOM]}
          locations={[0, 0.5, 1]}
          start={{ x: 0.5, y: 0 }}
          end={{ x: 0.5, y: 1 }}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
      }
      labelStyle={compact ? styles.labelTracked : styles.labelHero17}
      labelColor={tokens.color.textInverse}
      labelDisabledColor={B_LABEL_DISABLED}
      hapticKey="buttonPrimary"
      pressedScale={0.97}
    />
  );
}

// ─── C — Glass Primary (gold seal · teal sub-variant) + OPAL bloom ───────────

function GlassPrimary({
  label,
  onPress,
  disabled = false,
  compact = false,
  inCard = false,
  fullWidth = false,
  tone = 'gold',
}: LabButtonProps & { tone?: 'gold' | 'teal' }) {
  // Reduce Transparency (doc: mirror Card) — drop the BlurView, opaque base;
  // wash, rim, floor, border and halos all stay.
  const { reduceTransparency, resolved } = useReduceTransparency();
  const opaque = !resolved || reduceTransparency;

  const teal = tone === 'teal';
  const wash = teal ? CT_WASH : C_WASH;
  const washPressed = teal ? CT_WASH_PRESSED : C_WASH_PRESSED;
  const washDisabled = teal ? CT_WASH_DISABLED : C_WASH_DISABLED;

  return (
    <LabShell
      label={label}
      onPress={onPress}
      disabled={disabled}
      height={compact ? 48 : 56}
      radius={inCard ? tokens.radii.lg : tokens.radii.full}
      padH={compact ? tokens.spacing.lg : tokens.spacing.xl}
      minWidth={compact ? undefined : 200}
      fullWidth={fullWidth}
      outerHalo={teal ? iosShadow(CT_HALO_WIDE, 32, 6) : ambientGlow} // C gold: ambientGlow verbatim
      tightHalo={iosShadow(teal ? CT_HALO_TIGHT : C_HALO_TIGHT, 10, 2)}
      borderRest={teal ? CT_BORDER_REST : C_BORDER_REST}
      borderPressed={teal ? CT_BORDER_PRESSED : C_BORDER_PRESSED}
      borderDisabled={C_BORDER_DISABLED}
      rimRest={teal ? CT_RIM : C_RIM}
      rimPressed={C_RIM_PRESSED}
      rimDisabled={C_RIM_DISABLED}
      fillRest={
        <>
          {!opaque && (
            <BlurView intensity={45} tint="dark" style={StyleSheet.absoluteFill} pointerEvents="none" />
          )}
          <View
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: opaque ? C_OPAQUE_TINT : tokens.color.surface },
            ]}
            pointerEvents="none"
          />
          <DiagFill colors={wash} locations={C_WASH_LOCS} />
        </>
      }
      fillPressed={<DiagFill colors={washPressed} locations={C_WASH_LOCS} />}
      fillDisabled={
        <>
          {!opaque && (
            <BlurView intensity={45} tint="dark" style={StyleSheet.absoluteFill} pointerEvents="none" />
          )}
          <View
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: opaque ? C_OPAQUE_TINT : tokens.color.surface },
            ]}
            pointerEvents="none"
          />
          <View
            style={[StyleSheet.absoluteFill, { backgroundColor: washDisabled }]}
            pointerEvents="none"
          />
        </>
      }
      floorColor={C_FLOOR}
      // Doc: buttonPrimary 16, or 17 full-width; tracked variants in the seal hue.
      labelStyle={
        compact
          ? styles.labelTracked
          : fullWidth
            ? styles.labelHero17
            : styles.labelPrimary
      }
      labelColor={compact ? (teal ? tokens.color.teal : tokens.color.gold) : tokens.color.text}
      labelDisabledColor={C_LABEL_DISABLED}
      hapticKey="buttonPrimary"
      pressedScale={0.97}
    />
  );
}

// ─── OPAL — iridescent bloom-in-the-middle hero (opal-button-study.md) ───────

function OpalBloom({ label, onPress, disabled = false, fullWidth = false }: LabButtonProps) {
  const { reduceTransparency, resolved } = useReduceTransparency();
  const opaque = !resolved || reduceTransparency;

  const glassBase = (
    <>
      {!opaque && (
        <BlurView intensity={45} tint="dark" style={StyleSheet.absoluteFill} pointerEvents="none" />
      )}
      <View
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: opaque ? C_OPAQUE_TINT : tokens.color.surface },
        ]}
        pointerEvents="none"
      />
    </>
  );

  return (
    <LabShell
      label={label}
      onPress={onPress}
      disabled={disabled}
      height={56}
      radius={tokens.radii.full}
      padH={tokens.spacing.xl}
      minWidth={200}
      fullWidth={fullWidth}
      outerHalo={OPAL_HALO_WIDE} // quieted in v2.1 — Opal's pill carries no loud glow
      tightHalo={iosShadow(OPAL_HALO_TIGHT, 8, 2)}
      borderRest={OPAL_BORDER_REST}
      borderPressed={OPAL_BORDER_PRESSED}
      borderDisabled={C_BORDER_DISABLED}
      rimRest={OPAL_RIM}
      rimPressed={OPAL_RIM_PRESSED}
      rimDisabled={C_RIM_DISABLED}
      fillRest={
        <>
          {glassBase}
          <HFill colors={OPAL_SWEEP} locations={OPAL_SWEEP_LOCS} />
        </>
      }
      fillPressed={<HFill colors={OPAL_SWEEP_PRESSED} locations={OPAL_SWEEP_PRESSED_LOCS} />}
      fillDisabled={
        <>
          {glassBase}
          <HFill colors={OPAL_SWEEP_DISABLED} locations={OPAL_SWEEP_LOCS} />
        </>
      }
      floorColor={OPAL_FLOOR}
      labelStyle={styles.labelPrimary} // Inter SemiBold 16 sentence-case — already matches Opal
      labelColor={tokens.color.text}
      labelDisabledColor={C_LABEL_DISABLED}
      hapticKey="buttonPrimary"
      pressedScale={0.97}
    />
  );
}

// ─── D — Ghost / Outline (the permanent secondary) ───────────────────────────

function GhostButton({ label, onPress, disabled = false, compact = false, inCard = false, fullWidth = false }: LabButtonProps) {
  const radius = inCard ? tokens.radii.lg : tokens.radii.full;
  return (
    <View style={disabled && styles.ghostDisabled}>
      <LabShell
        label={label}
        onPress={onPress}
        disabled={disabled}
        height={compact ? 44 : 52}
        radius={radius}
        padH={compact ? tokens.spacing.lg : tokens.spacing.xl}
        fullWidth={fullWidth}
        outerHalo={iosShadow(D_CONTACT, 12, 4)} // contact shadow, NOT a glow
        borderRest={tokens.color.luminousEdge}
        borderPressed={D_BORDER_PRESSED}
        borderDisabled={tokens.color.luminousEdge}
        rimRest={D_RIM}
        rimPressed={D_RIM_PRESSED}
        rimDisabled={D_RIM}
        fillRest={<VFill colors={D_FILL} locations={D_FILL_LOCS} />}
        fillPressed={<VFill colors={D_FILL_PRESSED} locations={D_FILL_LOCS} />}
        labelStyle={styles.labelTracked}
        labelColor={tokens.color.text}
        labelDisabledColor={tokens.color.text}
        hapticKey="buttonSecondary"
        pressedScale={0.98}
      />
    </View>
  );
}

// ─── Treatment dispatcher ─────────────────────────────────────────────────────

function ActivePrimary(props: LabButtonProps & { treatment: Treatment }) {
  const { treatment, ...rest } = props;
  switch (treatment) {
    case 'OPAL':   return <OpalBloom {...rest} />;
    case 'A':      return <StarlightPill {...rest} />;
    case 'B':      return <StruckGoldPill {...rest} />;
    case 'C':      return <GlassPrimary {...rest} tone="gold" />;
    case 'C-TEAL': return <GlassPrimary {...rest} tone="teal" />;
    case 'D':      return <GhostButton {...rest} />;
  }
}

// ─── Screen ───────────────────────────────────────────────────────────────────

const TREATMENTS: Treatment[] = ['OPAL', 'A', 'B', 'C', 'C-TEAL', 'D'];

const TREATMENT_NOTES: Record<Treatment, string> = {
  OPAL: 'Opal bloom v2.1, quieted: dim gold → warm gleam → teal band dying to glass at both ends over blur 45. Soft halos, faint edge. Luminance near the background: hue does the work.',
  A: 'Starlight v2: vertical white sweep (#FFF → #DFE5F0), 1pt top rim, floor shade, two-stage cool-tinted halo. 0% gold, one per screen.',
  B: 'Struck gold: horizontal specular sweep (deep → bright → deep) + vertical shade overlay. Override-only: breaks the ≤5% gold budget.',
  C: 'Glass v2: blur 45 + diagonal gold → teal iridescent wash, white rim + floor, ambientGlow + tight gold bloom. ~0.87% gold.',
  'C-TEAL': 'Glass v2 teal: teal → white diagonal wash, teal seal + two-stage teal halo. 0% gold, sacred-active voice.',
  D: 'Ghost v2: vertical light-top gradient with faint bottom bounce, luminousEdge border, contact shadow instead of glow. Secondary.',
};

export default function ButtonLabScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [treatment, setTreatment] = useState<Treatment>('OPAL');

  const noop = () => {};

  return (
    <View style={styles.root}>
      <Pressable
        onPress={() => router.back()}
        hitSlop={12}
        style={[styles.backButton, { top: insets.top + 12 }]}
      >
        <Text style={styles.backLabel}>← BACK</Text>
      </Pressable>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + 48, paddingBottom: 100 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.title}>BUTTON LAB</Text>
        <Text style={styles.subtitle}>
          v2 craft pass: sweep fills, top rims, floors, two-stage halos.{'\n'}
          Press them. The light moves, the object stays.
        </Text>

        {/* ── Segmented switcher ─────────────────────────────────────────── */}
        <View style={styles.segmentRow}>
          {TREATMENTS.map((t) => {
            const active = t === treatment;
            return (
              <Pressable
                key={t}
                onPress={() => {
                  setTreatment(t);
                  haptic('tabChange');
                }}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                style={[styles.segment, active && styles.segmentActive]}
              >
                <Text style={[styles.segmentLabel, active && styles.segmentLabelActive]}>
                  {t}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={styles.note}>{TREATMENT_NOTES[treatment]}</Text>

        {/* ── 1 · Standalone hero CTA ────────────────────────────────────── */}
        <Text style={styles.sectionHeader}>HERO CTA</Text>
        <View style={styles.sectionBodyCentered}>
          <ActivePrimary treatment={treatment} label="Begin today's alignment" onPress={noop} />
          <View style={styles.heroGhostSpacer} />
          <GhostButton label="Not now" onPress={noop} compact />
        </View>
        <Text style={styles.caption}>
          Standalone pill (radii.full, 56pt) centered on the open field · ghost D secondary
        </Text>

        {/* ── 2 · Full-width primary inside a Card ───────────────────────── */}
        <Text style={styles.sectionHeader}>IN A CARD</Text>
        <Card>
          <Text style={styles.cardBody}>
            Save this reflection to today&apos;s record? The primary below uses radii.lg
            corners (C/D) so it marries the card it sits in.
          </Text>
          <View style={styles.cardButtons}>
            <ActivePrimary
              treatment={treatment}
              label="Save"
              onPress={noop}
              inCard
              fullWidth
            />
            <View style={styles.cardButtonSpacer} />
            <GhostButton label="Not now" onPress={noop} inCard fullWidth />
          </View>
        </Card>
        <Text style={styles.caption}>
          Full-width primary + ghost D secondary inside a real Card (blur 45, ambientGlow)
        </Text>

        {/* ── 3 · Disabled ───────────────────────────────────────────────── */}
        <Text style={styles.sectionHeader}>DISABLED</Text>
        <View style={styles.sectionBodyCentered}>
          <ActivePrimary treatment={treatment} label="Begin today's alignment" onPress={noop} disabled />
        </View>
        <Text style={styles.caption}>
          Same object drained: sweep, rim, floor and geometry survive; only the hue goes
        </Text>

        {/* ── 4 · Compact next to body text ──────────────────────────────── */}
        <Text style={styles.sectionHeader}>COMPACT</Text>
        <View style={styles.compactRow}>
          <Text style={styles.compactBody} numberOfLines={2}>
            Streak at risk: act before midnight to keep the chain alive.
          </Text>
          {treatment === 'A' || treatment === 'OPAL' ? (
            // Heroes ship one size per spec — shown at default 56pt.
            <ActivePrimary treatment={treatment} label="Act now" onPress={noop} />
          ) : (
            <ActivePrimary treatment={treatment} label="Act now" onPress={noop} compact />
          )}
        </View>
        <Text style={styles.caption}>
          {treatment === 'A' || treatment === 'OPAL'
            ? 'Hero treatments have no compact variant in the spec. Shown at default size'
            : 'Compact size (B 44 · C 48 · D 44) beside body text, tracked label'}
        </Text>
      </ScrollView>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // Root is transparent: the global StarField behind the Stack shows through.
  root: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  scroll: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  content: {
    paddingHorizontal: tokens.spacing.lg, // 24
  },

  backButton: {
    position: 'absolute',
    left: 16,
    zIndex: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  backLabel: {
    ...tokens.type.buttonTracked,
    fontSize: 12,
    lineHeight: 16,
    color: tokens.color.gold,
  },

  title: {
    ...tokens.type.labelTrackedLg,
    color: tokens.color.gold,
    textAlign: 'center',
  },
  subtitle: {
    ...tokens.type.caption,
    color: tokens.color.textMuted,
    textAlign: 'center',
    marginTop: tokens.spacing.sm,
  },

  // ── Segmented switcher (ghost-family chrome) ──
  segmentRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    flexWrap: 'wrap',
    gap: tokens.spacing.xs,
    marginTop: tokens.spacing.lg,
  },
  segment: {
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.xs,
    borderRadius: tokens.radii.full,
    borderWidth: 1,
    borderColor: tokens.color.luminousEdgeSoft,
    backgroundColor: D_FILL[1],
  },
  segmentActive: {
    borderColor: C_BORDER_REST,
    backgroundColor: C_WASH_DISABLED,
  },
  segmentLabel: {
    ...tokens.type.buttonTracked,
    color: tokens.color.textMuted,
  },
  segmentLabelActive: {
    color: tokens.color.gold,
  },
  note: {
    ...tokens.type.caption,
    color: tokens.color.textMuted,
    textAlign: 'center',
    marginTop: tokens.spacing.sm,
  },

  sectionHeader: {
    ...tokens.type.labelTrackedSm,
    color: tokens.color.gold,
    marginTop: tokens.spacing.xl,
    marginBottom: tokens.spacing.md,
  },
  sectionBodyCentered: {
    alignItems: 'center',
  },
  heroGhostSpacer: {
    height: tokens.spacing.md,
  },
  caption: {
    ...tokens.type.caption,
    color: tokens.color.textMuted,
    marginTop: tokens.spacing.sm,
    textAlign: 'center',
  },

  cardBody: {
    ...tokens.type.bodyMd,
    color: tokens.color.textSecondary,
  },
  cardButtons: {
    marginTop: tokens.spacing.lg,
  },
  cardButtonSpacer: {
    height: tokens.spacing.sm,
  },

  compactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: tokens.spacing.md,
  },
  compactBody: {
    ...tokens.type.bodyMd,
    color: tokens.color.textSecondary,
    flex: 1,
  },

  fullWidth: {
    alignSelf: 'stretch',
  },

  // ── Shell geometry ──
  shellOuter: {
    alignSelf: 'center',
  },
  shellInner: {
    borderWidth: 1,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rim: {
    position: 'absolute',
    top: 0,
    left: 1, // inset 1, inside the border
    right: 1,
    height: 1,
  },
  floor: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: FLOOR_HEIGHT,
  },

  ghostDisabled: {
    opacity: 0.4, // doc: disabled = opacity 0.4 on the outer wrapper
  },

  // ── Labels ──
  labelPrimary: {
    ...tokens.type.buttonPrimary,
  },
  labelHero17: {
    ...tokens.type.buttonPrimary,
    fontSize: 17, // v2: hero/primary labels at 17pt
    lineHeight: 21,
  },
  labelTracked: {
    ...tokens.type.buttonTracked,
  },
});
