// AdaptiveScreen — the adaptive content shell for wide viewports (iPad /
// desktop-class via "Designed for iPad"). On compact screens it is a plain
// full-bleed container; on wide screens it constrains CONTENT to a centered
// column of tokens-level max width (src/theme/layout.ts) so the phone layout
// reads centered rather than stretched edge-to-edge.
//
// WRAP CONTENT ONLY. Full-bleed backdrops and absolute overlays (StarField,
// the Command screen's layers, modals) must stay OUTSIDE this component —
// it is applied per-screen around the content region, never as a blanket
// route-root wrap.
import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useBreakpoints } from '@/src/theme/layout';

export type AdaptiveScreenProps = {
  children: React.ReactNode;
  // Style for the outer full-width container (rarely needed).
  style?: StyleProp<ViewStyle>;
  // Style merged onto the centered content column (e.g. extra padding).
  contentStyle?: StyleProp<ViewStyle>;
};

export function AdaptiveScreen({ children, style, contentStyle }: AdaptiveScreenProps) {
  const { isWide, contentMaxWidth } = useBreakpoints();
  return (
    <View style={[styles.outer, style]}>
      <View
        style={[
          styles.column,
          isWide && { maxWidth: contentMaxWidth },
          contentStyle,
        ]}
      >
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  outer: { flex: 1, alignItems: 'center' },
  // flex: 1 lets ScrollView children keep their bounded height; width: '100%'
  // + maxWidth does the centering on wide viewports and is a no-op on compact.
  column: { flex: 1, width: '100%' },
});
