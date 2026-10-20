import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useAppState, getLocalDateKey } from '@/src/state/app-state';
import { useShallow } from 'zustand/react/shallow';
import tokens from '@/src/theme/tokens';
import { stripEmoji } from '@/src/utils/text';
import { compareByStartISO } from '@/src/utils/orbit-sort';

export function TodayScreen() {
  const { habitLog, recurringRules, dailyTasks, orbitDays } = useAppState(
    useShallow((s: any) => ({
      habitLog: s.habitLog,
      recurringRules: s.recurringRules,
      dailyTasks: s.dailyTasks,
      orbitDays: s.orbitDays,
    })),
  );

  const todayKey = getLocalDateKey(new Date());

  const todayHabits = Array.isArray(habitLog)
    ? habitLog.filter((e: any) => e.dateKey === todayKey)
    : [];

  const todayTasks = Array.isArray(dailyTasks?.[todayKey])
    ? dailyTasks[todayKey]
    : [];

  // Sort a copy by start time. Home previously sorted orbitDays[todayKey] in
  // place during render, which silently normalized any unsorted hydrated/cloud
  // array; that mutation was removed (NEX-perf), so sort defensively here too.
  const todayEvents = Array.isArray(orbitDays?.[todayKey])
    ? [...orbitDays[todayKey]].sort(compareByStartISO)
    : [];

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Today</Text>

      <Text style={styles.sectionLabel}>Habits logged:</Text>
      {todayHabits.length === 0 ? (
        <Text style={styles.emptyText}>No habits logged yet today</Text>
      ) : (
        todayHabits.map((entry: any, i: number) => (
          <Text key={i} style={styles.item}>{'\u2022'} {stripEmoji(entry.habitTitle)}</Text>
        ))
      )}

      <Text style={styles.sectionLabel}>Tasks:</Text>
      {todayTasks.length === 0 ? (
        <Text style={styles.emptyText}>No tasks for today</Text>
      ) : (
        todayTasks.map((task: any, i: number) => (
          <Text key={i} style={[styles.item, task.completed && styles.completedItem]}>
            {task.completed ? '✓' : '\u2022'} {task.title}
          </Text>
        ))
      )}

      <Text style={styles.sectionLabel}>Schedule:</Text>
      {todayEvents.length === 0 ? (
        <Text style={styles.emptyText}>No events scheduled</Text>
      ) : (
        todayEvents.map((event: any, i: number) => (
          <Text key={i} style={styles.item}>{'\u2022'} {event.title} - {event.timeLabel || ''}</Text>
        ))
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: tokens.spacing.lg, backgroundColor: 'transparent'},
  // FIXME(nex-56): off-scale 30pt fontSize — design review
  title: { fontSize: 30, fontWeight: '700', color: tokens.color.text, marginBottom: tokens.spacing.md },
  // FIXME(nex-56): off-scale 18pt margin + 16pt fontSize — design review
  sectionLabel: { marginTop: 18, fontSize: 16, color: tokens.color.gold, fontWeight: '600', marginBottom: tokens.spacing.xs },
  // FIXME(nex-56): off-scale 6pt margin + 15pt fontSize — design review
  item: { marginTop: 6, fontSize: 15, color: tokens.color.text },
  completedItem: { color: tokens.color.textMuted, textDecorationLine: 'line-through' },
  // FIXME(nex-56): off-scale gray #555 + 14pt fontSize — design review
  emptyText: { color: tokens.color.textMuted, fontSize: 14, fontStyle: 'italic' },
});
