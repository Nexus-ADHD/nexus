/**
 * Redesign preview — Voice Orb (listening state)
 *
 * Access: /redesign/voice
 *
 * Just the ring, pulsing. A whisper of transcribing text below.
 * Nothing else.
 */

import React from 'react';
import {
  View,
  Text,
  SafeAreaView,
  StatusBar,
  TouchableOpacity,
} from 'react-native';
import { router } from 'expo-router';
import { colors, spacing, typography } from '@/src/theme/tokens';
import { VoiceOrb } from '@/src/components/redesign/VoiceOrb';

export default function VoiceRedesign() {
  const [active, setActive] = React.useState(true);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.basalt }}>
      <StatusBar barStyle="light-content" />

      <View
        style={{
          flex: 1,
          paddingHorizontal: spacing.xl,
        }}
      >
        {/* Top — subtle label */}
        <View
          style={{
            alignItems: 'center',
            paddingTop: spacing.xl,
          }}
        >
          <Text style={{ ...typography.label, color: colors.ember }}>
            {active ? 'Listening' : 'Tap to speak'}
          </Text>
        </View>

        {/* Center — the orb */}
        <View
          style={{
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <VoiceOrb
            active={active}
            size={260}
            onPress={() => setActive(!active)}
          />
        </View>

        {/* Transcript whisper */}
        <View
          style={{
            alignItems: 'center',
            paddingBottom: spacing.xxxl,
            minHeight: 80,
          }}
        >
          {active && (
            <Text
              style={{
                ...typography.display,
                // FIXME(nex-56): inline fontSize literal — design review
                fontSize: 18,
                lineHeight: 26,
                color: colors.dusk,
                textAlign: 'center',
                opacity: 0.6,
              }}
            >
              "I want to move with intention today."
            </Text>
          )}
        </View>

        {/* Dismiss */}
        <TouchableOpacity
          onPress={() => router.back()}
          style={{
            alignSelf: 'center',
            paddingVertical: spacing.md,
            paddingHorizontal: spacing.xl,
            marginBottom: spacing.md,
          }}
        >
          <Text style={{ ...typography.label, color: colors.sanctum }}>
            Close
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}
