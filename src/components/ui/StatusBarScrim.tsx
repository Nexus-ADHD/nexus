import React from 'react';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * Subtle dark gradient at the very top of a scrollable screen.
 *
 * Goal: keep the StarField visible while giving status-bar elements
 * (time, signal, battery) enough contrast against any content that
 * scrolls up under them. Replaces the earlier BlurView backdrop, which
 * covered the StarField and the inline back buttons.
 *
 * Render as the LAST sibling inside the screen's root <View/> so it
 * sits above the ScrollView but below any absolute-positioned header
 * chrome that uses zIndex >= 10.
 */
export function StatusBarScrim() {
  const insets = useSafeAreaInsets();
  return (
    <LinearGradient
      colors={['rgba(0,0,0,0.85)', 'rgba(0,0,0,0.5)', 'rgba(0,0,0,0)']}
      locations={[0, 0.6, 1]}
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: insets.top + 8,
        zIndex: 5,
      }}
    />
  );
}
