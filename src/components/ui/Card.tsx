/**
 * Card — stone-morphism card primitive (CLAUDE.md §10.1)
 *
 * v3 STELLAR (NEX-43 phase 2): cards are now translucent frosted glass
 * (BlurView) instead of opaque #111113. The cosmic backdrop peeks through
 * every card surface. Tokens (tokens.color.surface, etc.) are now
 * `rgba(...)` values — alone they tint without blur; the BlurView wrapper
 * adds the actual frost.
 *
 * Layer cake (bottom → top, drawn in this order inside the rounded card):
 *  1. BlurView absoluteFill (iOS native blur of cosmos behind)
 *  2. Animated tint overlay (the translucent dark color from tokens)
 *  3. Accent bar (left edge, if any)
 *  4. Inset highlight glow (luminous white, top edge — v3 was cream)
 *  5. Content
 *
 * Usage:
 *   // Default card
 *   <Card><Text>Hello</Text></Card>
 *
 *   // Pressable card with haptic
 *   <Card onPress={() => router.push('/detail')}><Text>Tap me</Text></Card>
 *
 *   // Card with gold accent bar
 *   <Card accentBar="gold"><Text>Featured</Text></Card>
 */

import React, { useCallback } from 'react';
import {
  StyleSheet,
  View,
  Pressable,
  type ViewStyle,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  Easing,
  interpolateColor,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { haptic } from '@/src/utils/haptics';
import tokens from '@/src/theme/tokens';
import { ambientGlow, ambientGlowSoft } from '@/src/theme/glow';
import { CornerGlows } from '@/src/components/ui/CornerGlows';
import { useReduceTransparency } from '@/hooks/use-reduce-transparency';
import { cardSurface } from './card-surface';

// TODO (§6.4): Grain overlay deferred under v3 stellar. The BlurView already
// supplies organic visual texture from the underlying cosmos photo, so the
// stone-morphism grain that v2 specced (warm-cream noise PNG) may be
// redundant. Revisit once the rest of the v3 palette lands — if cards still
// feel too clean, we can layer a 2% cool-toned grain. CLAUDE.md §6.4 will be
// rewritten then.

// ─── Types ────────────────────────────────────────────────────────────────────

export type CardProps = {
  children: React.ReactNode;
  variant?: 'default' | 'elevated';
  onPress?: () => void;
  accentBar?: 'none' | 'gold' | 'teal' | 'amber';
  /**
   * Opt-in luminous corner glows (NEX-158). Off by default so the treatment
   * stays special — turn it on for PRIMARY card surfaces (hero / section cards),
   * not list rows. Suppressed on the left edge automatically when an accent bar
   * is present.
   */
  cornerGlow?: boolean;
  /**
   * 'default' keeps the standard 24pt content padding. 'none' zeroes the
   * CONTENT wrapper padding (styles.content / contentWithBar — NOT the glow
   * wrapper) so children own their own padding; used by ListSection so row
   * pressed backgrounds reach the card edge (generic-list-row spec, PR 1).
   */
  padding?: 'default' | 'none';
  style?: ViewStyle;
  testID?: string;
};

// ─── Constants ────────────────────────────────────────────────────────────────

const ACCENT_BAR_WIDTH = 3;
const QUICK_MS = tokens.motion.quick.duration;           // 140ms
const QUICK_EASING = Easing.bezier(0.4, 0, 0.2, 1);

const ACCENT_COLORS: Record<NonNullable<CardProps['accentBar']>, string> = {
  none:  'transparent',
  gold:  tokens.color.gold,
  teal:  tokens.color.teal,
  amber: tokens.color.amber,
};

// Card tint colors (default/elevated, translucent vs opaque) are selected by
// cardSurface() per the Reduce Transparency preference — see card-surface.ts.
// Designer pass (2026-06): bumped from goldHairline (white @ 10%, near-invisible)
// to a crisp, clearly-visible white edge — the "pixel border" from the reference.
const BORDER_REST  = tokens.color.luminousEdge;     // v3 stellar: crisp 1px luminous-white edge (NEX-146/158)
// Press state bumps the edge opacity to 40% (above REST 0.28) for the
// active-state lift. CLAUDE.md §6.2 is now in sync — the card edge is the 1px
// luminous-white family (no longer the v2 gold hairline), so no FIXME remains.
const BORDER_PRESS = 'rgba(255,255,255,0.40)';

// BlurView intensity per variant — iOS native UIVisualEffectView.
// 25 = subtle frost, cosmos clearly visible. 35 = more occluded, used on
// elevated surfaces (modals/sheets) where reading sanctuary matters more.
const BLUR_INTENSITY_DEFAULT  = 45;
const BLUR_INTENSITY_ELEVATED = 55;

// ─── Component ────────────────────────────────────────────────────────────────

export function Card({
  children,
  variant = 'default',
  onPress,
  accentBar = 'none',
  cornerGlow = false,
  padding = 'default',
  style,
  testID,
}: CardProps) {
  const blurIntensity = variant === 'elevated' ? BLUR_INTENSITY_ELEVATED : BLUR_INTENSITY_DEFAULT;

  // Reduce Transparency (§17.4): drop the BlurView and paint near-opaque tints so
  // the cosmos doesn't bleed through. cardSurface supplies BOTH press-animation
  // endpoints opaque, so a pressable card never animates back to translucent.
  // Treat "not yet resolved" as reduce-transparency (opaque, no blur) so an RT
  // user never sees a one-frame blur flash before the async read resolves.
  const { reduceTransparency, resolved } = useReduceTransparency();
  const opaque = !resolved || reduceTransparency;
  const { rest: baseBg, pressed: pressedBg } = cardSurface(variant, opaque, {
    surface: tokens.color.surface,
    surfaceElevated: tokens.color.surfaceElevated,
    surfaceOpaque: tokens.color.surfaceOpaque,
    surfaceElevatedOpaque: tokens.color.surfaceElevatedOpaque,
  });

  // Reanimated shared values for press animation.
  // pressAnim drives both the tint-overlay color and the border color.
  const pressAnim = useSharedValue(0); // 0 = rest, 1 = pressed

  // Tint-overlay color animates from baseBg (rest) to the pressed tint.
  // interpolateColor handles rgba → rgba.
  const animatedTintStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      pressAnim.value,
      [0, 1],
      [baseBg, pressedBg],
    ),
  }));

  // Border color animates on the outer card View.
  const animatedBorderStyle = useAnimatedStyle(() => ({
    borderColor: interpolateColor(
      pressAnim.value,
      [0, 1],
      [BORDER_REST, BORDER_PRESS],
    ),
  }));

  const handlePressIn = useCallback(() => {
    pressAnim.value = withTiming(1, { duration: QUICK_MS, easing: QUICK_EASING });
    haptic('tabChange');
  }, [pressAnim]);

  const handlePressOut = useCallback(() => {
    pressAnim.value = withTiming(0, { duration: QUICK_MS, easing: QUICK_EASING });
  }, [pressAnim]);

  const hasAccentBar = accentBar !== 'none';

  const cardContent = (
    // Outer wrapper carries the ambient glow shadow — must NOT clip, so
    // the shadow extends outside the card's rounded bounds. Glow tier
    // follows the variant (owner-approved §2 amendment, 2026-08-06):
    // elevated keeps the full ambientGlow, ordinary cards get the soft tier.
    <View
      style={[
        styles.glowWrapper,
        variant === 'elevated' ? styles.glowElevated : styles.glowDefault,
        style,
      ]}
      testID={testID}
    >
      <Animated.View
        style={[
          styles.card,
          onPress ? animatedBorderStyle : { borderColor: BORDER_REST },
        ]}
      >
        {/* Layer 1 — iOS native blur of the cosmos behind the card. Removed
            under Reduce Transparency (§17.4); the opaque tint below stands in.
            Conditional render only flips on a rare system-setting toggle. */}
        {!opaque && (
          <BlurView
            intensity={blurIntensity}
            tint="dark"
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          />
        )}

        {/* Layer 2 — translucent dark tint overlay. Sits on top of the
            BlurView and gives the card its "dark glass" reading sanctuary.
            Animated so press state darkens the glass slightly. */}
        <Animated.View
          style={[
            StyleSheet.absoluteFill,
            onPress ? animatedTintStyle : { backgroundColor: baseBg },
          ]}
          pointerEvents="none"
        />

        {/* Layer 3 — accent bar (left edge, full height, inside border). */}
        {hasAccentBar && (
          <View
            style={[
              styles.accentBar,
              { backgroundColor: ACCENT_COLORS[accentBar] },
            ]}
            pointerEvents="none"
          />
        )}

        {/* Layer 4 — inset highlight glow (top edge, luminous white in v3
            stellar; was warm cream in v2). Matches
            tokens.material.insetHighlight.stops. */}
        <LinearGradient
          colors={['rgba(255,255,255,0.04)', 'rgba(255,255,255,0)']}
          locations={[0, 1]}
          start={{ x: 0, y: 0 }}
          end={{ x: 0, y: 1 }}
          style={styles.insetGlow}
          pointerEvents="none"
        />

        {/* Layer 5 — content. PaddingLeft shifts right of accent bar if present.
            padding="none" zeroes this wrapper's padding so children own it. */}
        <View
          style={
            padding === 'none'
              ? styles.contentNone
              : hasAccentBar
                ? styles.contentWithBar
                : styles.content
          }
        >
          {children}
        </View>
      </Animated.View>

      {/* Corner glows (NEX-158, opt-in) — sit OUTSIDE the card's overflow:hidden,
          here in the non-clipping glowWrapper, so the soft glow bleeds outward
          and reads as the border lighting up rather than an inward sheen. */}
      {cornerGlow && (
        <CornerGlows radius={tokens.radii.lg} suppressLeft={hasAccentBar} />
      )}
    </View>
  );

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        // Let Animated.View handle the visual state; Pressable is touch-only
        style={{ borderRadius: tokens.radii.lg }}
        accessibilityRole="button"
      >
        {cardContent}
      </Pressable>
    );
  }

  return cardContent;
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // Outer wrapper carries the ambient warm glow shadow.
  // Must NOT clip — the glow extends outside the card bounds.
  glowWrapper: {
    borderRadius: tokens.radii.lg,
  },

  // Two-tier ambient glow (owner-approved §2 amendment, 2026-08-06 — "spend
  // light like money"): ordinary cards get the SOFT halo so only one object
  // per surface reads as lit; elevated/hero surfaces keep the FULL halo.
  // Both read from src/theme/glow.ts so this Card primitive and every manual
  // card-shaped View across the app share one source of truth per tier.
  glowDefault: {
    ...ambientGlowSoft,
  },
  glowElevated: {
    // Full ambient gold halo: (229,186,110 @28%) / 36pt / +8 offset.
    ...ambientGlow,
  },

  card: {
    borderRadius: tokens.radii.lg,
    borderWidth: 1, // crisp 1px "pixel border" (was hairline ~0.5px) — designer pass
    overflow: 'hidden', // clips accent bar and inset glow to rounded corners
  },

  // Layer A — inset highlight glow (top ~18% of card height)
  insetGlow: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 48, // fixed height; gradient fades to transparent before content matters
    pointerEvents: 'none',
  },

  accentBar: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: ACCENT_BAR_WIDTH,
  },

  // Standard content padding (no accent bar)
  content: {
    padding: tokens.spacing.lg, // 24pt all sides
  },

  // padding="none" — children own their padding (ListSection rows). Kept as a
  // separate style (not an override) so the accent-bar directional paddings
  // can't survive the shorthand.
  contentNone: {
    padding: 0,
  },

  // Content padding when accent bar is present — left side gets extra 3pt
  contentWithBar: {
    paddingTop:    tokens.spacing.lg,
    paddingBottom: tokens.spacing.lg,
    paddingRight:  tokens.spacing.lg,
    paddingLeft:   tokens.spacing.lg + ACCENT_BAR_WIDTH, // 27pt: 24pt from bar + bar width
  },
});
