/**
 * Redesign preview — Onboarding (Welcome / Entry screen)
 *
 * Access: /redesign/onboarding
 *
 * Black void. Logo. One line. One CTA. Nothing else.
 */

import React from 'react';
import { View, Text, Image, TouchableOpacity, SafeAreaView, StatusBar } from 'react-native';
import { router } from 'expo-router';
import { colors, spacing, typography } from '@/src/theme/tokens';

export default function OnboardingRedesign() {
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.basalt }}>
      <StatusBar barStyle="light-content" />

      <View
        style={{
          flex: 1,
          paddingHorizontal: spacing.xl,
          justifyContent: 'space-between',
        }}
      >
        {/* Top breathing space */}
        <View style={{ flex: 1 }} />

        {/* Center — logo + invocation */}
        <View style={{ alignItems: 'center' }}>
          <Image
            source={require('../../assets/images/nexus-logo.png')}
            style={{ width: 200, height: 200 }}
            resizeMode="contain"
          />

          <Text
            style={{
              ...typography.display,
              color: colors.parchment,
              textAlign: 'center',
              marginTop: spacing.xxl,
              maxWidth: 280,
            }}
          >
            Remember who you are.
          </Text>
        </View>

        {/* Bottom breathing space */}
        <View style={{ flex: 1 }} />

        {/* CTA */}
        <TouchableOpacity
          onPress={() => router.push('/redesign/home')}
          activeOpacity={0.7}
          style={{
            alignSelf: 'center',
            paddingVertical: spacing.md,
            paddingHorizontal: spacing.xxl,
            borderWidth: 1,
            borderColor: colors.gold,
            borderRadius: 2,
            marginBottom: spacing.xxl,
          }}
        >
          <Text
            style={{
              ...typography.button,
              color: colors.gold,
            }}
          >
            Begin
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}
