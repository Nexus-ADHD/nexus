import React from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import tokens from '@/src/theme/tokens';
import { ambientGlowSoft } from '@/src/theme/glow';
import { haptic } from '@/src/utils/haptics';
import type { LeadTimeRollup } from '../../state/selectors/lead-time';
import { formatKeyShortWithWeekday } from '../../state/lead-time-types';

interface Props {
  rollup: LeadTimeRollup;
  onToggle: (id: string) => void;
  onAdd: () => void;
  onDelete: (id: string) => void;
}

export function LeadTimeOrbitSection({ rollup, onToggle, onAdd, onDelete }: Props) {
  const { open } = rollup;

  return (
    <View style={styles.wrap}>
      <View style={styles.headerRow}>
        <Text style={styles.headerLabel}>LEAD TIME</Text>
        <Pressable hitSlop={10} onPress={() => { haptic('modalPresent'); onAdd(); }} style={styles.addBtn}>
          <Text style={styles.addPlus}>+</Text>
        </Pressable>
      </View>

      {open.length === 0 ? (
        <Text style={styles.emptyText}>Nothing waits on the horizon yet.</Text>
      ) : (
        <View style={[styles.card, ambientGlowSoft]}>
          {open.map((a, i) => {
            const overdue = a.status === 'overdue';
            return (
              <Pressable
                key={a.id}
                onLongPress={() => {
                  haptic('longPressStart');
                  Alert.alert(a.title, undefined, [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Remove', style: 'destructive', onPress: () => onDelete(a.id) },
                  ]);
                }}
                style={[styles.row, i > 0 && styles.rowDivider]}
              >
                <Pressable
                  hitSlop={10}
                  onPress={() => { haptic('habitResolve'); onToggle(a.id); }}
                  style={styles.checkbox}
                />
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowTitle} numberOfLines={1}>{a.title}</Text>
                  <Text style={styles.rowMeta} numberOfLines={1}>
                    {a.eventTitle}
                  </Text>
                </View>
                <Text style={[styles.actBy, overdue && styles.actByOverdue]} numberOfLines={1}>
                  {overdue ? 'OVERDUE' : `ACT BY ${formatKeyShortWithWeekday(a.actByDate).toUpperCase()}`}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginHorizontal: 20, marginBottom: tokens.spacing.md },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: tokens.spacing.sm },
  headerLabel: { color: tokens.color.textMuted, fontSize: 13, fontWeight: '600', letterSpacing: 2.1 },
  addBtn: { paddingHorizontal: 6 },
  addPlus: { color: tokens.color.gold, fontSize: 20, fontWeight: '400', lineHeight: 22 },
  emptyText: { color: tokens.color.textSecondary, fontSize: 13, fontStyle: 'italic', textShadowColor: tokens.color.scrim, textShadowRadius: 4, textShadowOffset: { width: 0, height: 1 } },
  card: {
    backgroundColor: tokens.color.surface, borderRadius: 16, borderWidth: 1,
    borderColor: tokens.color.gold, paddingHorizontal: 16, paddingVertical: 4,
  },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, gap: 14 },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: tokens.color.goldHairline },
  checkbox: { width: 24, height: 24, borderRadius: 12, borderWidth: 1.25, borderColor: tokens.color.textMuted },
  rowTitle: { color: tokens.color.text, fontSize: 15, fontWeight: '600' },
  rowMeta: { color: tokens.color.textMuted, fontSize: 12, marginTop: 2 },
  actBy: { color: tokens.color.gold, fontSize: 11, fontWeight: '700', letterSpacing: 0.5, fontVariant: ['tabular-nums'] },
  actByOverdue: { color: tokens.color.stateError },
});
