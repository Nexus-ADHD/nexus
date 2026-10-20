// @ts-nocheck
import React, { useState, useEffect } from 'react';
import {
  Modal, View, Text, StyleSheet, ScrollView, Pressable, Alert,
  Platform,
} from 'react-native';
import {
  RecurrencePreset,
  RECURRENCE_PRESETS as PRESETS,
  presetToDays,
  presetToInterval,
  detectPreset,
} from '../../utils/recurrence-presets';
import tokens from '@/src/theme/tokens';
import { DayPicker } from '@/src/components/ui/DayPicker';
import { WEEKDAY_ABBR } from '@/src/utils/recurrence';
import { PrimaryPill } from '@/src/components/ui/PrimaryPill';

const BG = tokens.color.void;
const SURFACE = tokens.color.surface;
// FIXME(nex-56): neutral border, no token — design review (CLAUDE.md §6.2 wants gold hairline)
const BORDER = tokens.color.goldHairline;
const TEXT = tokens.color.text;
// FIXME(nex-56): off-scale gray; consider textMuted or design review
const MUTED = tokens.color.textMuted;
const GOLD = tokens.color.gold;


interface Props {
  todo: { id: string; title: string; daysOfWeek: number[]; interval?: number; intervalAnchorDate?: string } | null;
  onSave: (id: string, daysOfWeek: number[], interval: number) => void;
  onDismiss: () => void;
}

export function ScheduleEditModal({ todo, onSave, onDismiss }: Props) {
  const [preset, setPreset] = useState<RecurrencePreset>('daily');
  const [customDays, setCustomDays] = useState<number[]>([]);
  const [customInterval, setCustomInterval] = useState<number>(1);

  useEffect(() => {
    if (todo) {
      const initInterval = todo.interval || 1;
      const initPreset = detectPreset(todo.daysOfWeek || [], initInterval);
      setPreset(initPreset);
      setCustomDays(todo.daysOfWeek || []);
      setCustomInterval(initInterval);
    }
  }, [todo?.id]);

  if (!todo) return null;

  const handlePresetSelect = (p: RecurrencePreset) => {
    setPreset(p);
    const days = presetToDays(p);
    if (days.length > 0) setCustomDays(days);
    setCustomInterval(presetToInterval(p));
  };

  const toggleDay = (d: number) => {
    setCustomDays(prev =>
      prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d].sort((a, b) => a - b)
    );
  };

  const needsDayPicker = ['weekly', 'biweekly', 'monthly', 'custom'].includes(preset);
  const needsIntervalPicker = preset === 'custom';

  const effectiveDays = presetToDays(preset).length > 0 ? presetToDays(preset) : customDays;
  const effectiveInterval = presetToInterval(preset) > 1 ? presetToInterval(preset) : customInterval;

  const handleSave = () => {
    if (effectiveDays.length === 0) {
      Alert.alert('Select at least one day');
      return;
    }
    onSave(todo.id, effectiveDays, effectiveInterval);
    onDismiss();
  };

  return (
    <Modal visible animationType="slide" presentationStyle="formSheet" onRequestClose={onDismiss}>
      <View style={styles.container}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" automaticallyAdjustKeyboardInsets={true}>

          <View style={styles.handleRow}>
            <View style={styles.handle} />
          </View>

          <Text style={styles.label}>EDIT SCHEDULE</Text>
          <Text style={styles.title}>{todo.title}</Text>

          <Text style={styles.sectionLabel}>REPEAT</Text>
          <View style={styles.presetGrid}>
            {PRESETS.map(p => (
              <Pressable
                key={p.id}
                onPress={() => handlePresetSelect(p.id)}
                style={[styles.presetCard, preset === p.id && styles.presetCardActive]}
              >
                <Text style={[styles.presetLabel, preset === p.id && styles.presetLabelActive]}>{p.label}</Text>
                <Text style={[styles.presetSub, preset === p.id && styles.presetSubActive]}>{p.sub}</Text>
              </Pressable>
            ))}
          </View>

          {needsDayPicker && (
            <>
              <Text style={[styles.sectionLabel, { marginTop: tokens.spacing.lg }]}>DAY</Text>
              <DayPicker
                mode="multi"
                value={customDays}
                onChange={setCustomDays}
                label="Repeat days"
              />
            </>
          )}

          {needsIntervalPicker && (
            <>
              <Text style={[styles.sectionLabel, { marginTop: tokens.spacing.lg }]}>EVERY N WEEKS</Text>
              <View style={styles.intervalRow}>
                {[1, 2, 3, 4, 6, 8].map(n => (
                  <Pressable
                    key={n}
                    onPress={() => setCustomInterval(n)}
                    style={[styles.intervalBtn, customInterval === n && styles.intervalBtnActive]}
                  >
                    <Text style={[styles.intervalText, customInterval === n && styles.intervalTextActive]}>
                      {n === 1 ? 'Weekly' : `${n}w`}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </>
          )}

          <View style={styles.summaryBox}>
            <Text style={styles.summaryText}>
              {effectiveDays.length === 7
                ? 'Every day'
                : effectiveDays.length === 0
                  ? 'No days selected'
                  : effectiveInterval === 1
                    ? `Every ${effectiveDays.map(d => WEEKDAY_ABBR[d]).join(', ')}`
                    : `Every ${effectiveInterval} weeks on ${effectiveDays.map(d => WEEKDAY_ABBR[d]).join(', ')}`}
            </Text>
          </View>

          <PrimaryPill fullWidth style={{ marginBottom: tokens.spacing.sm }} onPress={handleSave}>
            SAVE SCHEDULE
          </PrimaryPill>
          <Pressable style={styles.cancelBtn} onPress={onDismiss} hitSlop={4} accessibilityRole="button" accessibilityLabel="Cancel">
            <Text style={styles.cancelBtnText}>CANCEL</Text>
          </Pressable>

        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  // FIXME(nex-56): off-scale 60pt paddingBottom — design review
  scroll: { padding: tokens.spacing.lg, paddingBottom: 60 },
  // FIXME(nex-56): off-scale 20pt margin — design review
  handleRow: { alignItems: 'center', marginBottom: 20 },
  // FIXME(nex-56): neutral handle gray #333, no token — design review
  handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: tokens.color.textDisabled },
  // FIXME(nex-56): off-scale 10pt fontSize — design review
  label: { color: GOLD, fontSize: 10, fontWeight: '900', letterSpacing: 3, marginBottom: tokens.spacing.xs },
  // FIXME(nex-56): off-scale 24pt fontSize + 28pt margin — design review
  title: { color: TEXT, fontSize: 24, fontWeight: '800', letterSpacing: -0.5, marginBottom: 28 },
  // FIXME(nex-56): off-scale 9pt fontSize — design review
  sectionLabel: { color: MUTED, fontSize: 9, fontWeight: '900', letterSpacing: 2, marginBottom: tokens.spacing.sm },
  // FIXME(nex-56): off-scale gap 10 — design review
  presetGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  presetCard: {
    width: '47%', backgroundColor: SURFACE, borderRadius: 14, borderWidth: 1,
    borderColor: BORDER, padding: tokens.spacing.md,
  },
  // FIXME(nex-56): selected-state gold-dark tint bg #1A1400, no token — design review
  presetCardActive: { backgroundColor: tokens.color.goldWash, borderColor: GOLD },
  // FIXME(nex-56): off-scale 14pt fontSize — design review
  presetLabel: { color: TEXT, fontSize: 14, fontWeight: '700', marginBottom: tokens.spacing.xxs },
  presetLabelActive: { color: GOLD },
  // FIXME(nex-56): off-scale 11pt fontSize — design review
  presetSub: { color: MUTED, fontSize: 11 },
  // FIXME(nex-56): off-scale gray #888, no token — design review
  presetSubActive: { color: tokens.color.textMuted },
  // FIXME(nex-56): off-scale gap 6 — design review
  // FIXME(nex-56): off-scale 12pt paddingVertical + 10pt radius — design review
  intervalRow: { flexDirection: 'row', gap: tokens.spacing.xs },
  // FIXME(nex-56): off-scale 12pt paddingVertical + 10pt radius — design review
  intervalBtn: {
    flex: 1, paddingVertical: 12, borderRadius: 10, borderWidth: 1,
    borderColor: BORDER, backgroundColor: SURFACE, alignItems: 'center',
  },
  // FIXME(nex-56): selected-state gold-dark tint bg #1A1400, no token — design review
  intervalBtnActive: { backgroundColor: tokens.color.goldWash, borderColor: GOLD },
  // FIXME(nex-56): off-scale 11pt fontSize — design review
  intervalText: { color: MUTED, fontSize: 11, fontWeight: '700' },
  intervalTextActive: { color: GOLD },
  summaryBox: {
    marginTop: tokens.spacing.lg, backgroundColor: SURFACE, borderRadius: 12,
    borderWidth: 1, borderColor: BORDER, padding: tokens.spacing.md, marginBottom: tokens.spacing.lg,
  },
  // FIXME(nex-56): off-scale 14pt fontSize — design review
  summaryText: { color: TEXT, fontSize: 14, lineHeight: 22 },
  cancelBtn: { alignItems: 'center', paddingVertical: tokens.spacing.sm },
  // FIXME(nex-56): off-scale 11pt fontSize — design review
  cancelBtnText: { color: MUTED, fontSize: 11, fontWeight: '700', letterSpacing: 1.5 },
});
