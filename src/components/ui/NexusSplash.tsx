/**
 * NEX-303 — the canonical loading surface.
 *
 * The "N E X U S" wordmark over the gold glyph rain (MatrixRain), replacing the
 * stock gold ActivityIndicator. This component exists to be the ONE owner of the
 * loading register: before it, the wordmark + spinner block was duplicated
 * across five places (both app/_layout.tsx gates, preparing-interstitial,
 * retry-screen, and the dev showcase via preparing-interstitial), and they had
 * already drifted — retry-screen still described a "warm void background" from
 * the v2 palette.
 *
 * Accessibility note, because it inverts what you might assume: this is a
 * net-new IMPROVEMENT, not regression-avoidance. The bare
 * `<ActivityIndicator color={GOLD} size="small" />` it replaces carried NO
 * label and announced essentially nothing to VoiceOver. So there is no prior
 * announcement to preserve — we are adding one. `accessibilityState.busy` plus
 * a real label is the load-bearing signal (what PrimaryPill already does);
 * `accessibilityRole="progressbar"` maps to no iOS trait and is deliberately
 * not used.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import tokens from '@/src/theme/tokens';
import { MatrixRain } from './MatrixRain';

export interface NexusSplashProps {
  /**
   * Optional copy under the wordmark (the interstitial's two-line register).
   * Omitted on the app-shell gates, which show the wordmark alone.
   */
  readonly label?: string;
  /**
   * Background treatment.
   *  - 'void'        — paints tokens.color.void. For the app-shell gates, which
   *                    render BEFORE the global StarField mounts and so have
   *                    nothing behind them. Also lets the rain blend against an
   *                    opaque color rather than forcing a full-screen alpha
   *                    composite.
   *  - 'transparent' — for surfaces mounted OVER the StarField (the
   *                    interstitial), whose cosmos must show through.
   */
  readonly background?: 'void' | 'transparent';
  /**
   * VoiceOver announcement for the surface. Defaults to a neutral line; pass a
   * surface-specific one where the wait has meaning. Per §18 voice: declarative,
   * no second-person coaching, no exclamation.
   */
  readonly accessibilityLabel?: string;
  readonly testID?: string;
}

const DEFAULT_A11Y_LABEL = 'Nexus is loading.';

export function NexusSplash({
  label,
  background = 'void',
  accessibilityLabel,
  testID,
}: NexusSplashProps) {
  return (
    <View
      style={[
        styles.root,
        background === 'void' ? { backgroundColor: tokens.color.void } : styles.transparent,
      ]}
      testID={testID}
      // ONE a11y element for the whole surface. On iOS `accessible` on the
      // parent absorbs its descendants, so the children's own guards are
      // belt-and-braces there. They are NOT redundant on Android: TalkBack does
      // not merge children into an accessible parent, so without the guards
      // below the wordmark would surface as its own node and be read out letter
      // by letter alongside this label.
      accessible
      accessibilityLabel={accessibilityLabel ?? label ?? DEFAULT_A11Y_LABEL}
      accessibilityState={{ busy: true }}
    >
      <MatrixRain />
      <View
        style={styles.stack}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Text style={styles.wordmark} maxFontSizeMultiplier={1.4}>
          N E X U S
        </Text>
        {label ? (
          <Text style={styles.label} maxFontSizeMultiplier={1.6}>
            {label}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  transparent: {
    // The global StarField (app/_layout.tsx) shows through.
    backgroundColor: 'transparent',
  },
  stack: {
    alignItems: 'center',
  },
  wordmark: {
    color: tokens.color.gold,
    // FIXME(nex-56): off-scale fontSize 20 (NEXUS wordmark), design review.
    // Carried over verbatim from the gates this component replaces — this is a
    // pre-existing scale deviation, not a new one.
    fontSize: 20,
    fontWeight: '900',
    letterSpacing: 8,
  },
  label: {
    color: tokens.color.textMuted,
    // FIXME(nex-56): fontSize 13 matches caption size but fontWeight default
    // differs from token '500'; lineHeight 20 vs token 18. Carried over from
    // preparing-interstitial rather than silently re-specced here.
    fontSize: 13,
    marginTop: 18 /* FIXME(nex-56): off-scale spacing 18 — between md(16) and lg(24) */,
    letterSpacing: 0.5,
    textAlign: 'center',
    lineHeight: 20,
  },
});

export default NexusSplash;
