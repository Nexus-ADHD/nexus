// NEX-316 (roadmap 1.3, safe slice): the visible listening waveform.
//
// This is the RN/Reanimated glue that turns the pure cadence model
// (waveform-cadence.ts) + geometry model (waveform-model.ts) into a trace on
// screen. It is intentionally NOT Skia: 24 thin Reanimated bars driven off a
// single shared-value array are dead simple, have none of Skia's device-render
// gotchas, and are more than enough for a breath-scale ornament (§1.4).
//
// One JS ticker (StarField-style, §6.6) writes one shared value per tick; each
// bar reads its own index in a worklet, so amplitude never crosses into React
// render. The trace scrolls left as new levels arrive on the right, which is
// what makes it read as time passing rather than a bar chart.
//
// The whole component is decorative: it is hidden from the accessibility tree,
// and the orb keeps `accessibilityLabel="Listening"`, so the listening state is
// still announced to VoiceOver even though the visual carrier is now a wave
// (§1.5 UF-01 — a decorative visual may never be the only carrier of a state).

import React, { useEffect, useRef } from 'react';
import { View } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import tokens from '../../theme/tokens';
import { BAR_COUNT, IDLE_LEVEL, idleHistory, pushLevel, barHeights } from './waveform-model';
import { TICK_MS, nextWaveLevel, changeMagnitude } from './waveform-cadence';

const BAR_WIDTH = 3;
const BAR_GAP = 3;
const WAVE_HEIGHT = 40; // container; ~ the poetic line it replaces, so layout holds
const MIN_BAR = 3;
const MAX_BAR = 36;

/**
 * Drive a shared-value array of bar heights (0..1) off the recognizer's cadence.
 *
 * @param active whether the trace should be running (the swap predicate result)
 * @param text   the live transcript so far; its LENGTH is the cadence source
 */
export function useCadenceWaveform(active: boolean, text: string) {
  const heights = useSharedValue<number[]>(barHeights(idleHistory()));
  const lenRef = useRef(0);
  const prevLenRef = useRef(0);
  const levelRef = useRef(IDLE_LEVEL);
  const histRef = useRef<number[]>(idleHistory());
  const tickRef = useRef(0);

  // Keep the latest transcript length in a ref so the interval closure reads
  // the current value rather than a stale capture.
  useEffect(() => {
    lenRef.current = typeof text === 'string' ? text.length : 0;
  }, [text]);

  useEffect(() => {
    if (!active) {
      // Reset to a clean idle trace so the next capture starts fresh, and
      // baseline the length so re-entry does not read the whole prior
      // transcript as one giant change spike.
      histRef.current = idleHistory();
      levelRef.current = IDLE_LEVEL;
      prevLenRef.current = lenRef.current;
      tickRef.current = 0;
      heights.value = barHeights(histRef.current);
      return;
    }
    // Baseline the length at capture start so the first tick's change is
    // measured from here, not from a stale prior value.
    prevLenRef.current = lenRef.current;
    const id = setInterval(() => {
      const { delta, nextLen } = changeMagnitude(prevLenRef.current, lenRef.current);
      prevLenRef.current = nextLen;
      tickRef.current += 1;
      const level = nextWaveLevel(levelRef.current, delta, tickRef.current);
      levelRef.current = level;
      histRef.current = pushLevel(histRef.current, level);
      heights.value = barHeights(histRef.current);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [active, heights]);

  return heights;
}

function WaveBar({ heights, index }: { heights: SharedValue<number[]>; index: number }) {
  const style = useAnimatedStyle(() => {
    const arr = heights.value;
    const h = arr && arr.length > index ? arr[index] : IDLE_LEVEL;
    return { height: MIN_BAR + h * (MAX_BAR - MIN_BAR) };
  });
  return (
    <Animated.View
      style={[
        {
          width: BAR_WIDTH,
          borderRadius: BAR_WIDTH / 2,
          backgroundColor: tokens.color.teal,
        },
        style,
      ]}
    />
  );
}

/**
 * The trace itself — a centered row of bars that grow symmetrically from the
 * midline. Decorative: hidden from accessibility, and it never intercepts a tap
 * (the orb behind it owns the gesture).
 */
export function CommandWaveform({ heights }: { heights: SharedValue<number[]> }) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        height: WAVE_HEIGHT,
        marginBottom: tokens.spacing.md,
        columnGap: BAR_GAP,
      }}
    >
      {Array.from({ length: BAR_COUNT }).map((_, i) => (
        <WaveBar key={i} heights={heights} index={i} />
      ))}
    </View>
  );
}
