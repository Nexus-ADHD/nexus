/**
 * VoiceOrb — the app's focal ritual element.
 *
 * Uses the actual Nexus logo as the orb.
 * Soft pulse animation when listening (opacity 0.85 <-> 1.0, 3s cycle).
 * Tap to activate.
 */

import React, { useEffect, useRef } from 'react';
import { View, Image, Animated, TouchableOpacity } from 'react-native';
import { colors } from '@/src/theme/tokens';

type Props = {
  /** Is actively listening / focal */
  active?: boolean;
  size?: number;
  onPress?: () => void;
};

export const VoiceOrb: React.FC<Props> = ({
  active = false,
  size = 140,
  onPress,
}) => {
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (active) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulse, {
            toValue: 0.85,
            duration: 1500,
            useNativeDriver: true,
          }),
          Animated.timing(pulse, {
            toValue: 1,
            duration: 1500,
            useNativeDriver: true,
          }),
        ])
      ).start();
    } else {
      pulse.setValue(1);
    }
  }, [active, pulse]);

  const content = (
    <Animated.View
      style={{
        width: size,
        height: size,
        opacity: pulse,
      }}
    >
      <Image
        source={require('../../../assets/images/nexus-logo.png')}
        style={{ width: size, height: size }}
        resizeMode="contain"
      />
    </Animated.View>
  );

  if (onPress) {
    return (
      <TouchableOpacity onPress={onPress} activeOpacity={0.9}>
        {content}
      </TouchableOpacity>
    );
  }

  return content;
};
