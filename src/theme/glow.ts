/**
 * Ambient glow styles — the "lit from within" gold halo that sits beneath
 * card-like surfaces in the app. TWO TIERS (owner-approved §2 amendment,
 * 2026-08-06 — "spend light like money"; spec: docs/design/NEXUS-DESIGN-SYSTEM.md
 * §4.9, rationale: docs/design/explorations/2026-08-06-opal-visual-system.md):
 *
 *   ambientGlow     — FULL halo. Hero / elevated surfaces only (the one lit
 *                     object per surface: hero cards, modals, sheets).
 *                     Reads from tokens.material.shadow.ambient.
 *   ambientGlowSoft — SOFT halo. Ordinary list cards. Same gold hue family,
 *                     quieter (0.10 alpha / 20pt radius / +4 offset), so only
 *                     one object per surface reads as lit.
 *                     Reads from tokens.material.shadow.ambientSoft.
 *
 * Spread into a StyleSheet entry to apply, e.g.:
 *
 *   intentionCard: {
 *     backgroundColor: tokens.color.surface,
 *     borderRadius: 18,
 *     ...
 *     ...ambientGlowSoft,
 *   }
 *
 * Platform.select returns iOS shadow props on iOS and an elevation
 * fallback on Android. The result is non-null on both platforms so
 * spreading it is always safe.
 */
import { Platform, type ViewStyle } from 'react-native';
import tokens from './tokens';

// Cast both branches to ViewStyle so TS doesn't infer Platform.select's
// type from just the iOS shape (which then errors on android's
// `elevation` key as "unknown").
export const ambientGlow: ViewStyle =
  (Platform.select<ViewStyle>({
    ios: tokens.material.shadow.ambient as ViewStyle,
    android: { elevation: tokens.material.shadow.ambientAndroidElevation } as ViewStyle,
  }) ?? {}) as ViewStyle;

export const ambientGlowSoft: ViewStyle =
  (Platform.select<ViewStyle>({
    ios: tokens.material.shadow.ambientSoft as ViewStyle,
    android: { elevation: tokens.material.shadow.ambientSoftAndroidElevation } as ViewStyle,
  }) ?? {}) as ViewStyle;
