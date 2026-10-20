/**
 * Toggle — kit switch (docs/plans/form-controls.md, component 1 of 5).
 *
 * Wraps the stock RN Switch: the geometry stays system, because the platform
 * control is already accessible, already animated, and already reads as a
 * switch to every assistive technology. What the kit owns is the PALETTE and
 * the HAPTIC — the two things that had drifted three ways across the app
 * (gold@60 / goldTrackActive / raw gold tracks; gold / textInverse /
 * textDisabled thumbs).
 *
 * Usage — inside a row, the row does NOT drive the value:
 *   <ListRow
 *     title="Milestone Alerts"
 *     trailing="toggle"
 *     trailingAccessory={
 *       <Toggle value={on} onValueChange={setOn} accessibilityLabel="Milestone Alerts" />
 *     }
 *   />
 */

import React, { useCallback } from 'react';
import { Platform, Switch, View } from 'react-native';
import { haptic } from '@/src/utils/haptics';
import tokens from '@/src/theme/tokens';
import { resolveToggleColors } from './toggle-colors';

export type ToggleProps = {
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
  /**
   * REQUIRED in practice on a `ListRow trailing="toggle"`. That row is not a
   * single accessibility element (the control must stay reachable), so the
   * row's own label never reaches this switch — and `ListRow`'s `accessoryLabel`
   * feeds only the row-level label, making it a no-op here. Without this, every
   * toggle announces as an unnamed "switch, on".
   */
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
};

export function Toggle({
  value,
  onValueChange,
  disabled = false,
  accessibilityLabel,
  accessibilityHint,
  testID,
}: ToggleProps) {
  const resolved = resolveToggleColors({
    value,
    disabled,
    platform: Platform.OS === 'ios' ? 'ios' : 'android',
  });

  // Toggle owns the value-change haptic so the single-haptic rule is structural
  // rather than remembered at 11 call sites (#388 is the cautionary tale).
  // ListRow already suppresses its press haptic when it hosts an interactive
  // accessory, so exactly one fires. A disabled Switch never calls this.
  const handleValueChange = useCallback(
    (next: boolean) => {
      haptic('buttonSecondary');
      onValueChange(next);
    },
    [onValueChange],
  );

  return (
    <View style={{ opacity: resolved.opacity }}>
      <Switch
        value={value}
        onValueChange={handleValueChange}
        disabled={disabled}
        trackColor={{
          false: tokens.color.luminousEdgeSoft,
          true: tokens.color.teal,
        }}
        // 'native' = pass nothing: setting thumbColor on iOS strips the grip's
        // drop shadow (RN Switch docs), and iOS already ships a white thumb.
        thumbColor={resolved.thumb === 'light' ? tokens.color.text : undefined}
        ios_backgroundColor={tokens.color.luminousEdgeSoft}
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
        testID={testID}
      />
    </View>
  );
}
