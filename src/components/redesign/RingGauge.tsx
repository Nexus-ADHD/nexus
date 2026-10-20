/**
 * RingGauge — the core Nexus visual motif.
 *
 * The logo IS the gauge. Extends into score displays, activity indicators,
 * avatars, and loading states. Every instance of a ring in the app should
 * feel like it descended from the same archetype.
 */

import React from 'react';
import { View, Text } from 'react-native';
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg';
import { colors, typography } from '@/src/theme/tokens';

type Props = {
  /** 0-100 */
  progress: number;
  /** Display number inside ring (defaults to progress) */
  value?: number | string;
  /** Optional label under the number */
  label?: string;
  /** Size of the ring in pixels */
  size?: number;
  /** Stroke thickness */
  strokeWidth?: number;
};

export const RingGauge: React.FC<Props> = ({
  progress,
  value,
  label,
  size = 220,
  strokeWidth = 2,
}) => {
  const center = size / 2;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, progress));
  const dashOffset = circumference * (1 - clamped / 100);

  const displayValue = value !== undefined ? value : Math.round(clamped);

  return (
    <View
      style={{
        width: size,
        height: size,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Svg width={size} height={size}>
        <Defs>
          <RadialGradient id="goldGlow" cx="50%" cy="50%" r="50%">
            <Stop offset="70%" stopColor="rgba(212,175,55,0)" />
            <Stop offset="100%" stopColor="rgba(212,175,55,0.25)" />
          </RadialGradient>
        </Defs>

        {/* Outer glow */}
        <Circle
          cx={center}
          cy={center}
          r={radius + 4}
          stroke="none"
          fill="url(#goldGlow)"
        />

        {/* Track (unfilled) */}
        <Circle
          cx={center}
          cy={center}
          r={radius}
          stroke={colors.granite}
          strokeWidth={strokeWidth}
          fill="none"
        />

        {/* Progress ring */}
        <Circle
          cx={center}
          cy={center}
          r={radius}
          stroke={colors.gold}
          strokeWidth={strokeWidth}
          strokeDasharray={`${circumference}`}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
          fill="none"
          transform={`rotate(-90 ${center} ${center})`}
        />
      </Svg>

      {/* Center content */}
      <View
        style={{
          position: 'absolute',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text
          style={{
            ...typography.numeralLarge,
            color: colors.parchment,
          }}
        >
          {displayValue}
        </Text>
        {label && (
          <Text
            style={{
              ...typography.label,
              color: colors.ember,
              marginTop: 8,
            }}
          >
            {label}
          </Text>
        )}
      </View>
    </View>
  );
};
