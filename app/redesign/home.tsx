/**
 * Redesign preview — Home Command Center
 *
 * Access: /redesign/home
 *
 * Top: tiny date label
 * Center: alignment score as ring gauge (the logo archetype)
 * Below: 3 minimal habit rows
 * Bottom: tab bar with central gold orb
 */

import React from 'react';
import {
  View,
  Text,
  SafeAreaView,
  ScrollView,
  StatusBar,
  TouchableOpacity,
} from 'react-native';
import { router } from 'expo-router';
import { colors, spacing, typography } from '@/src/theme/tokens';
import { RingGauge } from '@/src/components/redesign/RingGauge';
import { HabitRow } from '@/src/components/redesign/HabitRow';

function formatDate(): string {
  const d = new Date();
  const days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const months = [
    'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
    'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
  ];
  return `${days[d.getDay()]} · ${months[d.getMonth()]} ${d.getDate()}`;
}

export default function HomeRedesign() {
  const [habits, setHabits] = React.useState([
    { id: '1', name: 'Meditate', completed: true, count: '1/1' },
    { id: '2', name: 'Train', completed: false, count: '0/1' },
    { id: '3', name: 'Create', completed: true, count: '1/1' },
  ]);

  const toggle = (id: string) => {
    setHabits((prev) =>
      prev.map((h) =>
        h.id === id
          ? {
              ...h,
              completed: !h.completed,
              count: !h.completed ? '1/1' : '0/1',
            }
          : h
      )
    );
  };

  const completedCount = habits.filter((h) => h.completed).length;
  const score = Math.round((completedCount / habits.length) * 100);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.basalt }}>
      <StatusBar barStyle="light-content" />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: spacing.xxxl }}
      >
        {/* Date header */}
        <View
          style={{
            paddingHorizontal: spacing.xl,
            paddingTop: spacing.lg,
            paddingBottom: spacing.xxl,
          }}
        >
          <Text style={{ ...typography.label, color: colors.dusk }}>
            {formatDate()}
          </Text>
        </View>

        {/* Score gauge */}
        <View
          style={{
            alignItems: 'center',
            paddingVertical: spacing.xl,
          }}
        >
          <RingGauge progress={score} label="ALIGNED" size={220} />
        </View>

        {/* Poetic subtitle */}
        <View
          style={{
            alignItems: 'center',
            marginTop: spacing.lg,
            marginBottom: spacing.xxxl,
            paddingHorizontal: spacing.xl,
          }}
        >
          <Text
            style={{
              ...typography.display,
              // FIXME(nex-56): inline fontSize literal — design review
              fontSize: 20,
              lineHeight: 28,
              color: colors.dusk,
              textAlign: 'center',
            }}
          >
            Become him one day at a time.
          </Text>
        </View>

        {/* Section label */}
        <View
          style={{
            paddingHorizontal: spacing.xl,
            paddingBottom: spacing.sm,
            borderBottomWidth: 0.5,
            borderBottomColor: colors.goldGhost,
          }}
        >
          <Text style={{ ...typography.label, color: colors.ember }}>
            Disciplines
          </Text>
        </View>

        {/* Habits */}
        <View style={{ paddingHorizontal: spacing.sm }}>
          {habits.map((h) => (
            <HabitRow
              key={h.id}
              name={h.name}
              completed={h.completed}
              count={h.count}
              onPress={() => toggle(h.id)}
            />
          ))}
        </View>

        {/* Voice orb link */}
        <View
          style={{
            alignItems: 'center',
            marginTop: spacing.xxxl,
          }}
        >
          <TouchableOpacity
            onPress={() => router.push('/redesign/voice')}
            activeOpacity={0.7}
          >
            <Text style={{ ...typography.label, color: colors.gold }}>
              Speak →
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
