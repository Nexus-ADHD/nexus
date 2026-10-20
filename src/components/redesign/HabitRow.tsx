/**
 * HabitRow — minimal horizontal row for habit tracking.
 *
 * Left: small gold ring indicator (echoes the logo/score gauge)
 * Middle: habit name in clean type
 * Right: small tabular count (e.g., "1/1")
 *
 * Separated by thin 0.5px gold-ghost divider.
 * No backgrounds, no card chrome. Just air and type.
 */

import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { colors, spacing, typography } from '@/src/theme/tokens';

type Props = {
  name: string;
  completed: boolean;
  count?: string;
  onPress?: () => void;
};

const Indicator: React.FC<{ completed: boolean }> = ({ completed }) => {
  const size = 16;
  const radius = 6;
  const center = size / 2;

  return (
    <Svg width={size} height={size}>
      <Circle
        cx={center}
        cy={center}
        r={radius}
        stroke={completed ? colors.gold : colors.granite}
        strokeWidth={1}
        fill={completed ? colors.gold : 'none'}
      />
    </Svg>
  );
};

export const HabitRow: React.FC<Props> = ({
  name,
  completed,
  count,
  onPress,
}) => {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: spacing.lg,
        paddingHorizontal: spacing.md,
        borderBottomWidth: 0.5,
        borderBottomColor: colors.goldGhost,
      }}
    >
      <Indicator completed={completed} />
      <Text
        style={{
          ...typography.body,
          color: completed ? colors.parchment : colors.dusk,
          flex: 1,
          marginLeft: spacing.md,
        }}
      >
        {name}
      </Text>
      {count && (
        <Text
          style={{
            ...typography.numeral,
            color: completed ? colors.gold : colors.sanctum,
          }}
        >
          {count}
        </Text>
      )}
    </TouchableOpacity>
  );
};
