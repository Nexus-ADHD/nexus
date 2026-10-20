import { haptic } from '@/src/utils/haptics';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import tokens from '@/src/theme/tokens';

// ─── Types ────────────────────────────────────────────────────────────────────

export type SectionHeaderProps = {
  children: React.ReactNode;
  action?: {
    label: string;
    onPress: () => void;
  };
  spacing?: 'major' | 'standard' | 'tight';
  testID?: string;
};

// ─── Spacing maps ─────────────────────────────────────────────────────────────

const MARGIN_TOP: Record<NonNullable<SectionHeaderProps['spacing']>, number> = {
  major:    tokens.spacing.xl,  // 32
  standard: tokens.spacing.lg,  // 24
  tight:    tokens.spacing.sm,  // 12
};

const MARGIN_BOTTOM: Record<NonNullable<SectionHeaderProps['spacing']>, number> = {
  // FIXME(nex-56): off-scale 20pt — design review (nearest md 16pt or lg 24pt)
  major:    20,
  standard: tokens.spacing.md,  // 16
  tight:    tokens.spacing.sm,  // 12
};

// ─── Component ────────────────────────────────────────────────────────────────

export function SectionHeader({
  children,
  action,
  spacing = 'standard',
  testID,
}: SectionHeaderProps) {
  return (
    <View
      style={[
        styles.row,
        { marginTop: MARGIN_TOP[spacing], marginBottom: MARGIN_BOTTOM[spacing] },
      ]}
      testID={testID}
    >
      <Text style={styles.label}>{children}</Text>

      {action && (
        <Pressable
          onPress={() => {
            haptic('tabChange');
            action.onPress();
          }}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel={action.label}
        >
          <Text style={styles.action}>{action.label}</Text>
        </Pressable>
      )}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  row: {
    flexDirection:  'row',
    justifyContent: 'space-between',
    alignItems:     'baseline',
  },

  label: {
    ...tokens.type.labelTrackedLg,
    // v3 stellar follow-up: section labels were textMuted (#9AA3B5) —
    // bumped to textSecondary so they actually anchor each section
    // against the cosmic backdrop. Soft warm glow underneath makes
    // every section feel lit from within rather than floating dead.
    color: tokens.color.textSecondary,
    textShadowColor: 'rgba(229, 186, 110, 0.35)',
    textShadowRadius: 8,
    textShadowOffset: { width: 0, height: 0 },
  },

  action: {
    ...tokens.type.labelTrackedSm,
    color: tokens.color.gold,
    // v3 stellar follow-up: action labels (EDIT, MANAGE, THIS WEEK ›)
    // get a brighter gold glow to read as tappable accent.
    textShadowColor: 'rgba(229, 186, 110, 0.55)',
    textShadowRadius: 10,
    textShadowOffset: { width: 0, height: 0 },
  },
});
