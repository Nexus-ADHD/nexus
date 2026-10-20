// components/VoiceOrb.tsx
import { useCallback, useEffect } from 'react';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useFocusEffect } from 'expo-router';
import { Pressable, StyleProp, ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';

import { useReduceMotion } from '@/hooks/use-reduce-motion';
import { ornamentMayAnimate } from '@/src/utils/reduce-motion-policy';

export type VoiceOrbState = 'idle' | 'listening' | 'talking';

export interface VoiceOrbProps {
  /**
   * Visible width in points. Height is derived from the 9:16 source.
   * Omit to fill the parent container — used by the Command tab's
   * full-bleed background mode (with contentFit="cover" so the orb
   * crops to the viewport instead of letterboxing).
   */
  width?: number;
  state?: VoiceOrbState;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  accessibilityHint?: string;
}

// Static require — Metro resolves at bundle time. Do NOT wrap in try/catch.
const ORB_IDLE = require('../assets/videos/orb-idle.mp4');

const PLAYBACK_RATES: Record<VoiceOrbState, number> = {
  idle: 1.0,
  listening: 1.18,
  talking: 1.42,
};

const SCALES: Record<VoiceOrbState, number> = {
  idle: 1.0,
  listening: 1.05,
  talking: 1.08,
};

const SPRING_CONFIG = { damping: 18, stiffness: 140 } as const;

export function VoiceOrb({
  width,
  state = 'idle',
  onPress,
  style,
  accessibilityLabel = 'Voice',
  accessibilityHint,
}: VoiceOrbProps) {
  // Two render modes:
  //   - sized:      caller passes width; height is 9:16-derived and
  //                 contentFit="contain" preserves the soft alpha edges
  //                 (showcase + any explicit-size embedding).
  //   - full-bleed: caller omits width; Pressable fills the parent and
  //                 contentFit="cover" crops the transparent edges off
  //                 the viewport so the visible halo dominates.
  const isFullBleed = width === undefined;
  const sizedDimensions = isFullBleed ? null : { width, height: (width * 16) / 9 };

  // The looping video is ORNAMENT: the orb is a button, and its label and
  // press behavior carry the whole control without a single frame playing.
  // So it gates on `ornamentMayAnimate` (confirmed Reduce Motion OFF), not on
  // `resolved` — every unconfirmed window (first render, in-flight read,
  // FAILED read) stays still. §1.5 UF-01, and the LEARNINGS 2026-07-24 rule
  // that a decorative visual must fail toward its absence.
  //
  // Paused still shows the current frame, so the orb remains a visible anchor
  // on the Command surface. It stops moving; it does not disappear.
  const reduceMotionState = useReduceMotion();
  const mayLoop = ornamentMayAnimate(reduceMotionState);

  const player = useVideoPlayer(ORB_IDLE, (p) => {
    p.loop = true;
    p.muted = true;
    // Don't acquire the iOS audio session exclusively. The orb's video
    // is muted so it has no audio output that needs to win against
    // other audio — but the default 'auto' mode locks the session into
    // .playback, which blocks SFSpeechRecognizer from setting
    // .playAndRecord (the recognizer would then loop trying to flip
    // the category until iOS SIGTERMs the process). 'mixWithOthers'
    // lets the muted playback ride alongside whatever the recognizer
    // wants to do.
    p.audioMixingMode = 'mixWithOthers';
    // Deliberately no play() here. Playback is owned by the effect below so
    // that a reduce-motion user never sees the first frames of the loop
    // before the preference read lands.
  });

  useEffect(() => {
    if (mayLoop) player.play();
    else player.pause();
  }, [player, mayLoop]);

  // expo-video pauses the player when the host screen blurs and
  // doesn't auto-resume on return. Call play() on every focus event
  // so the orb's loop resumes seamlessly. Intentionally NOT pausing
  // on blur — pausing would cause a visible re-buffer flash on the
  // first frame when the screen comes back.
  //
  // Gated on the same predicate: without it, focus would resume the loop for a
  // reduce-motion user every time they returned to the tab.
  useFocusEffect(
    useCallback(() => {
      if (mayLoop) player.play();
    }, [player, mayLoop]),
  );

  // Drive playbackRate from state. Loop + play are set once at init;
  // rate updates land live without restart.
  useEffect(() => {
    player.playbackRate = PLAYBACK_RATES[state];
  }, [player, state]);

  // Reanimated scale tied to state — spring out from the orb's center
  // on listening/talking transitions, settle back on idle.
  //
  // The scale is FUNCTIONAL, not ornament: it is the feedback that listening
  // actually started. So it keeps its target value under Reduce Motion and
  // only loses the spring, arriving instantly instead. Before the preference
  // resolves it also jumps, so no transition plays on an unknown preference.
  const scale = useSharedValue(SCALES[state]);
  useEffect(() => {
    const target = SCALES[state];
    if (!reduceMotionState.resolved || reduceMotionState.reduceMotion) {
      scale.value = target;
      return;
    }
    scale.value = withSpring(target, SPRING_CONFIG);
  }, [scale, state, reduceMotionState.resolved, reduceMotionState.reduceMotion]);
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePress = () => {
    if (!onPress) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onPress();
  };

  return (
    <Pressable
      onPress={handlePress}
      disabled={!onPress}
      style={[
        // Full-bleed default uses absolute-fill insets (top/right/bottom/left)
        // rather than width/height. Explicit width/height take precedence over
        // inset-derived sizing in RN, so using 100%/100% here was silently
        // overriding consumer styles like { bottom: 320 } meant to shrink the
        // orb. Insets let the consumer's style merge over cleanly.
        isFullBleed
          ? { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }
          : sizedDimensions,
        style,
      ]}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={onPress ? accessibilityLabel : undefined}
      accessibilityHint={onPress ? accessibilityHint : undefined}
    >
      {/* Decorative video — hide from VoiceOver so the orb reads as one element. */}
      <Animated.View
        style={[{ width: '100%', height: '100%' }, animatedStyle]}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <VideoView
          player={player}
          style={{ width: '100%', height: '100%', backgroundColor: 'transparent' }}
          contentFit={isFullBleed ? 'cover' : 'contain'}
          nativeControls={false}
        />
      </Animated.View>
    </Pressable>
  );
}
