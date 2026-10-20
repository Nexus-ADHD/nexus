// PaywallContentPreview (NEX-121) — "paywall as content". Shows the SILHOUETTE
// of the user's own insight: their alignment ring arc + a 7-day debrief bar
// shape, frosted behind a blur, with the deeper analytics (the numbers) locked.
// The upgrade reads as a natural extension of the instrument, not an interruption.
//
// PRIVACY: no readable values are rendered (shape only — see AlignmentScoreRing
// `showValue={false}` + the bars-only WeeklyDebriefChart). The blur is aesthetic,
// not the privacy mechanism (a blur can be defeated; an absent value cannot).
//
// Data: the user's real alignment SHAPE from scoreHistory when they have enough
// history, else a representative arc (clearly framed as "what's ahead", never as
// their data). Pure selection in paywall-preview-data.ts.
import React, { useEffect, useMemo } from 'react';
import { StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import tokens from '@/src/theme/tokens';
import { ambientGlow } from '@/src/theme/glow';
import { useAppState } from '@/src/state/app-state';
import { lastNDayKeys } from '@/src/state/pause-mode';
import { useReduceMotion } from '@/hooks/use-reduce-motion';
import { useReduceTransparency } from '@/hooks/use-reduce-transparency';
import { AlignmentScoreRing } from '@/src/components/ui/AlignmentScoreRing';
import { WeeklyDebriefChart } from '@/src/components/ui/WeeklyDebriefChart';
import { pickPreviewStats, type PreviewStats } from './paywall-preview-data';

const ENTRY_MS = tokens.motion.standard.duration; // 250ms
const EASE_OUT = Easing.bezier(0.2, 0, 0, 1);
const RING_SIZE = 150; // compact (DEFAULT_SIZE is 264) so the CTA stays reachable
const BLUR_INTENSITY = 20; // aesthetic frosting over the shapes (not privacy)

function localTodayKey(): string {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

export type PaywallContentPreviewProps = {
  /** Override the derived stats (showcase / tests). Default: derived from app-state. */
  statsOverride?: PreviewStats;
  style?: ViewStyle;
  testID?: string;
};

export function PaywallContentPreview({ statsOverride, style, testID }: PaywallContentPreviewProps) {
  const scoreHistory = useAppState((s: any) => s.scoreHistory);

  const stats = useMemo<PreviewStats>(() => {
    if (statsOverride) return statsOverride;
    // lastNDayKeys returns newest→oldest (today first); pickPreviewStats + the
    // chart expect oldest→newest (today on the right, matching Home's weeklyStats
    // and the "current = most recent = last index" contract). Reverse here.
    const dayKeys = lastNDayKeys(localTodayKey(), 7).slice().reverse();
    return pickPreviewStats(scoreHistory, dayKeys);
  }, [statsOverride, scoreHistory]);

  const { reduceMotion, resolved: rmResolved } = useReduceMotion();
  const { reduceTransparency, resolved: rtResolved } = useReduceTransparency();
  // Treat unresolved as reduce-transparency (opaque scrim, no blur) so an RT user
  // never sees a one-frame blur flash — mirrors Card.tsx.
  const opaque = !rtResolved || reduceTransparency;

  // §7 entry: fade (+ slight rise unless Reduce Motion). Run once after the RM
  // pref resolves (never schedule withTiming before it's known).
  const opacity = useSharedValue(0);
  const translateY = useSharedValue(8);
  useEffect(() => {
    if (!rmResolved) return;
    if (reduceMotion) {
      translateY.value = 0;
      opacity.value = withTiming(1, { duration: ENTRY_MS, easing: EASE_OUT });
      return;
    }
    opacity.value = withTiming(1, { duration: ENTRY_MS, easing: EASE_OUT });
    translateY.value = withTiming(0, { duration: ENTRY_MS, easing: EASE_OUT });
  }, [rmResolved, reduceMotion, opacity, translateY]);
  const animStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }],
  }));

  const title = stats.isRepresentative ? "A glimpse of what's ahead." : 'Your insight, in focus.';

  return (
    <Animated.View style={[styles.wrapper, ambientGlow, animStyle, style]} testID={testID}>
      <View style={styles.card}>
        {/* Shape layer — rendered FIRST so the BlurView above frosts it. No
            readable values (ring showValue=false, bars only). pointerEvents none. */}
        <View style={styles.shape} pointerEvents="none">
          <AlignmentScoreRing score={stats.score} size={RING_SIZE} showValue={false} />
          <WeeklyDebriefChart dayScores={stats.dayScores} style={styles.chart} />
        </View>

        {/* Frosting on TOP of the shape. expo-blur blurs the siblings behind it.
            Under Reduce Transparency (or before it resolves) use a scrim instead. */}
        {opaque ? (
          <View style={[StyleSheet.absoluteFill, styles.scrim]} pointerEvents="none" />
        ) : (
          <BlurView intensity={BLUR_INTENSITY} tint="dark" style={StyleSheet.absoluteFill} pointerEvents="none" />
        )}

        {/* Lock layer — sharp, on top of the frosting. box-none so it can't
            swallow taps meant for the paywall around it. */}
        <View style={[StyleSheet.absoluteFill, styles.lockLayer]} pointerEvents="box-none">
          <Ionicons name="lock-closed" size={22} color={tokens.color.gold} />
          <Text style={styles.title} maxFontSizeMultiplier={1.4}>{title}</Text>
          <Text style={styles.sub} maxFontSizeMultiplier={1.6}>Premium reveals the trend behind your days.</Text>
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    width: '100%',
  },
  card: {
    borderRadius: 20,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: tokens.color.luminousEdge,
    backgroundColor: tokens.color.surface,
    paddingVertical: 24,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 260,
  },
  shape: {
    // Full width so the 7-bar row isn't constrained to the ring's 150px and
    // clipped by the card's overflow:hidden (the ring still centers via
    // alignItems). Without this the outermost bars are silently truncated.
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 18,
  },
  chart: {
    width: '100%',
  },
  scrim: {
    backgroundColor: tokens.color.surfaceElevated,
  },
  lockLayer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    gap: 8,
  },
  title: {
    fontFamily: 'Fraunces-LightItalic',
    fontSize: 22,
    lineHeight: 28,
    color: tokens.color.text,
    textAlign: 'center',
  },
  sub: {
    fontFamily: 'Inter-Regular',
    fontSize: 14,
    lineHeight: 20,
    color: tokens.color.textSecondary,
    textAlign: 'center',
  },
});
