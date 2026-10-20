/**
 * Moment5Screen — NEX-120, the onboarding finale (CLAUDE.md §12, "Moment 5").
 *
 * The ceremonial seam at the end of the 5-moment ritual: "You have begun." →
 * "ENTER NEXUS". This is the deliberate beat the rest of NEX-120 was about — the
 * paywall placement itself already lands here (the launch gate renders right
 * after activation, NEX-204 + NEX-234), so this screen exists to make that seam
 * feel like a continuation of the ritual rather than a tollbooth. The body copy
 * acknowledges that the offer follows ("Your practice begins today.").
 *
 * Backdrop: the global StarField is already mounted behind every screen
 * (app/_layout.tsx), so we render transparent over it and add a faint ring mark
 * to evoke the threshold. This is an intentional, design-approved substitution
 * for §12's literal "ghost Home at 18%" (mounting Home pre-activation is heavy,
 * and a 0-mandate/0-habit new user has no real Home to ghost) — see
 * docs/plans/nex-120-onboarding-paywall-moment5.md (§22.4 deviation).
 *
 * Motion: §7 entry (fade + 8pt rise), no springs; honors Reduce Motion
 * (opacity-only). The StarField keeps its own sanctioned motion (§1.4).
 */

import React, { useEffect, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import tokens from '@/src/theme/tokens';
import { haptic } from '@/src/utils/haptics';
import { trackEvent } from '@/src/services/analytics';
import { useReduceMotion } from '@/hooks/use-reduce-motion';
import { PrimaryPill } from '@/src/components/ui/PrimaryPill';
import { AdaptiveScreen } from '@/src/components/ui/AdaptiveScreen';

const ENTRY_MS = tokens.motion.entry.duration; // 350ms
const EASE_OUT = Easing.bezier(0.2, 0, 0, 1);
const RING_OUTER = 240;
const RING_INNER = 188;

export default function Moment5Screen({ onEnter }: { onEnter: () => void }) {
  const insets = useSafeAreaInsets();
  const { reduceMotion: reduceMotionValue, resolved: rmResolved } = useReduceMotion();

  // Start hidden + offset. We intentionally do NOT seed these from an
  // unresolved Reduce-Motion value: the pref resolves async (rmResolved is false
  // on the first render), so seeding opacity to 1 there would make the later
  // withTiming animate from the final value and never visibly play. Never
  // schedule a withTiming before the pref is known (same rule as HabitRow).
  const opacity = useSharedValue(0);
  const translateY = useSharedValue(8);

  // Screen-view analytics — fire exactly once on mount, independent of the
  // motion effect below (which re-runs when the RM pref resolves; the view event
  // must not double-fire).
  const viewedRef = useRef(false);
  useEffect(() => {
    if (viewedRef.current) return;
    viewedRef.current = true;
    void trackEvent('moment_5_viewed', {});
  }, []);

  // §7 entry (fade + 8pt rise), played exactly once after the RM pref resolves.
  // Reduce Motion → opacity-only (fade, no rise) per §7.6 / §17.3.
  const animStartedRef = useRef(false);
  useEffect(() => {
    if (!rmResolved || animStartedRef.current) return;
    animStartedRef.current = true;
    if (reduceMotionValue) {
      translateY.value = 0; // no rise under Reduce Motion
      opacity.value = withTiming(1, { duration: ENTRY_MS, easing: EASE_OUT });
      return;
    }
    opacity.value = withTiming(1, { duration: ENTRY_MS, easing: EASE_OUT });
    translateY.value = withTiming(0, { duration: ENTRY_MS, easing: EASE_OUT });
  }, [rmResolved, reduceMotionValue, opacity, translateY]);

  const contentStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }],
  }));

  // One-shot guard: ENTER NEXUS triggers activation, which unmounts this screen
  // only on the next render — a double tap before then would commitActivation
  // twice. Fire once.
  const enteredRef = useRef(false);
  const handleEnter = () => {
    if (enteredRef.current) return;
    enteredRef.current = true;
    haptic('habitPressIn');
    // Funnel-consistent completion emit (mirrors the other onboarding_step_completed
    // events, which all carry an integer `step`). step 5 = the finale; we skip 4 to
    // avoid overloading the integer of the NEX-193-removed first-habit picker (old
    // step 4) in historical funnels. `key:'moment_5'` is the canonical discriminator.
    void trackEvent('onboarding_step_completed', { phase: 'setup', step: 5, key: 'moment_5' });
    onEnter();
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom + 48 }]}>
      <AdaptiveScreen>
      <Animated.View style={[styles.center, contentStyle]}>
        {/* Faint ring mark — the "cathedral preview" evoked on the global
            StarField, in place of a literal ghost Home (see header). */}
        <View pointerEvents="none" style={styles.ringWrap}>
          <View style={[styles.ring, styles.ringOuter]} />
          <View style={[styles.ring, styles.ringInner]} />
        </View>

        <Text style={styles.title} maxFontSizeMultiplier={1.4}>You have begun.</Text>
        <View style={styles.underline} />
        <Text style={styles.body} maxFontSizeMultiplier={1.6}>Your practice begins today.</Text>
      </Animated.View>

      <Animated.View style={[styles.cta, contentStyle]}>
        <PrimaryPill onPress={handleEnter} accessibilityLabel="Enter Nexus">ENTER NEXUS</PrimaryPill>
      </Animated.View>
      </AdaptiveScreen>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'transparent', // global StarField shows through
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ringWrap: {
    position: 'absolute',
    width: RING_OUTER,
    height: RING_OUTER,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ring: {
    position: 'absolute',
    borderWidth: 1,
    borderRadius: RING_OUTER,
  },
  // Faintness via the `opacity` style on each (border-only, no-bg) ring so the
  // color stays the canonical gold TOKEN rather than a baked rgba literal
  // (CLAUDE.md §22.1 — reference tokens, never hex).
  ringOuter: {
    width: RING_OUTER,
    height: RING_OUTER,
    borderColor: tokens.color.gold,
    opacity: 0.10,
  },
  ringInner: {
    width: RING_INNER,
    height: RING_INNER,
    borderColor: tokens.color.gold,
    opacity: 0.16,
  },
  title: {
    fontFamily: 'Fraunces-LightItalic',
    fontSize: 36,
    lineHeight: 42,
    color: tokens.color.text,
    textAlign: 'center',
  },
  underline: {
    width: 120,
    height: StyleSheet.hairlineWidth,
    backgroundColor: tokens.color.gold,
    marginTop: 18,
    marginBottom: 18,
  },
  body: {
    fontFamily: 'Fraunces-LightItalic',
    fontSize: 18,
    lineHeight: 26,
    color: tokens.color.textSecondary,
    textAlign: 'center',
  },
  cta: {
    // `center` is flex:1 and pushes this to the bottom; container paddingBottom
    // (insets.bottom + 48) provides the safe-area gap. No absolute positioning,
    // so it always clears the home indicator.
    alignSelf: 'center',
  },
});
