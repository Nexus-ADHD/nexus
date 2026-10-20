import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View, KeyboardAvoidingView, Platform } from 'react-native';
import { haptic } from '@/src/utils/haptics';
import { PrimaryPill } from '@/src/components/ui/PrimaryPill';
import DateTimePicker from '@react-native-community/datetimepicker';
import tokens from '@/src/theme/tokens';
import { DayPicker } from '@/src/components/ui/DayPicker';

// JSX-attribute hex hazard — TextInput/DateTimePicker props can't carry inline FIXMEs.
const PLACEHOLDER_COLOR = tokens.color.textMuted;
const DATE_PICKER_TEXT = tokens.color.text;

import { ManualOrbitEventInput, OrbitEnergy, TimeBlock, useAppState } from '../../state/app-state';
import { getLocalDateKey } from '../../utils/recurrence';
import { wideBlockEndTime } from '../../utils/time-blocks';
import {
  RecurrencePreset,
  RECURRENCE_PRESETS,
  presetToDays,
  presetToInterval,
  presetNeedsDayPicker,
} from '../../utils/recurrence-presets';

const TIME_BLOCKS: TimeBlock[] = ['morning', 'afternoon', 'evening', 'night'];
// NEX-205 (Or-2): energy tags for time-blocks. The wide 90-min default + clock
// math live in src/utils/time-blocks.ts (pure, vitest-covered).
const ENERGY_TAGS: OrbitEnergy[] = ['deep', 'light', 'recharge'];
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

type OrbitManualAddMode = 'appointment' | 'routine' | 'todo' | 'recurring_todo' | 'time_block';

interface OrbitManualAddSheetProps {
  visible: boolean;
  onClose: () => void;
  selectedDate?: Date;
  defaultDateKey?: string;
}

const emptyErrors = {
  title: '',
  dateKey: '',
  startTime: '',
  endTime: '',
  daysOfWeek: '',
  timeIntent: '',
};

function parseDateKey(dk: string): Date {
  const parts = dk.split('-');
  if (parts.length === 3) {
    const d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
    if (!isNaN(d.getTime())) return d;
  }
  return new Date();
}

function parseTime(t: string, fallbackH: number, fallbackM: number): Date {
  const [h, m] = (t || `${fallbackH}:${fallbackM}`).split(':').map(Number);
  const d = new Date();
  d.setHours(h || fallbackH, m || fallbackM, 0, 0);
  return d;
}

function formatDateLabel(dk: string): string {
  const d = parseDateKey(dk);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[d.getDay()]}, ${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function formatTimeLabel(t: string): string {
  const [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

function OrbitManualAddSheet({
  visible,
  onClose,
  selectedDate,
  defaultDateKey,
}: OrbitManualAddSheetProps) {
  const resolvedDefaultDateKey = defaultDateKey || getLocalDateKey(selectedDate || new Date());

  const addManualOrbitEvent = useAppState((s) => s.addManualOrbitEvent);
  const addRecurringRule = useAppState((s) => s.addRecurringRule);
  const addRecurringToDo = useAppState((s) => s.addRecurringToDo);
  const addDailyTask = useAppState((s) => s.addDailyTask);

  const [mode, setMode] = useState<OrbitManualAddMode>('appointment');
  const [title, setTitle] = useState('');
  const [dateKey, setDateKey] = useState(resolvedDefaultDateKey);
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('10:00');
  const [selectedDays, setSelectedDays] = useState<number[]>([]);
  const [routineTime, setRoutineTime] = useState('');
  const [routineBlock, setRoutineBlock] = useState<TimeBlock | null>(null);
  const [energy, setEnergy] = useState<OrbitEnergy | null>(null); // NEX-205: time_block energy tag
  // Recurring-to-do form state — same vocabulary as ScheduleEditModal
  // (see src/utils/recurrence-presets.ts) so editing later doesn't drift.
  const [recurPreset, setRecurPreset] = useState<RecurrencePreset>('weekly');
  const [recurInterval, setRecurInterval] = useState<number>(1);
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>(emptyErrors);

  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showStartPicker, setShowStartPicker] = useState(false);
  const [showEndPicker, setShowEndPicker] = useState(false);
  const [showRoutineTimePicker, setShowRoutineTimePicker] = useState(false);

  useEffect(() => {
    if (visible) {
      setDateKey(resolvedDefaultDateKey);
      setShowDatePicker(false);
      setShowStartPicker(false);
      setShowEndPicker(false);
      setShowRoutineTimePicker(false);
    }
  }, [visible, resolvedDefaultDateKey]);

  // NEX-205: entering time_block mode opens the end-time at a wide 90-min
  // default (a "window," not a clock slot). Only on mode-entry — the user can
  // still set any end time after. Keyed on `mode` deliberately.
  useEffect(() => {
    if (mode === 'time_block') {
      setEndTime(wideBlockEndTime(startTime));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const titleLabel = useMemo(() => {
    switch (mode) {
      case 'appointment':
        return 'ADD APPOINTMENT';
      case 'routine':
        return 'ADD ROUTINE';
      case 'todo':
        return 'ADD TO-DO';
      case 'recurring_todo':
        return 'ADD RECURRING TASK';
      case 'time_block':
        return 'ADD TIME BLOCK';
    }
  }, [mode]);

  const resetForm = () => {
    setMode('appointment');
    setTitle('');
    setDateKey(resolvedDefaultDateKey);
    setStartTime('09:00');
    setEndTime('10:00');
    setSelectedDays([]);
    setRoutineTime('');
    setRoutineBlock(null);
    setEnergy(null);
    setRecurPreset('weekly');
    setRecurInterval(1);
    setNotes('');
    setErrors(emptyErrors);
    setShowDatePicker(false);
    setShowStartPicker(false);
    setShowEndPicker(false);
    setShowRoutineTimePicker(false);
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const toggleDay = (dayIndex: number) => {
    haptic('buttonSecondary');
    setSelectedDays((prev) =>
      prev.includes(dayIndex) ? prev.filter((d) => d !== dayIndex) : [...prev, dayIndex].sort((a, b) => a - b)
    );
  };

  const toggleRoutineBlock = (block: TimeBlock) => {
    haptic('buttonSecondary');
    setRoutineBlock((prev) => (prev === block ? null : block));
  };

  const validate = () => {
    const nextErrors = { ...emptyErrors };

    if (!title.trim()) nextErrors.title = 'Title is required.';

    if ((mode === 'appointment' || mode === 'time_block' || mode === 'todo') && !DATE_ONLY_RE.test(dateKey)) {
      nextErrors.dateKey = 'Date must use YYYY-MM-DD.';
    }

    if (mode === 'appointment' || mode === 'time_block') {
      if (!TIME_RE.test(startTime)) nextErrors.startTime = 'Start time must use HH:MM.';
      if (!TIME_RE.test(endTime)) nextErrors.endTime = 'End time must use HH:MM.';
      if (TIME_RE.test(startTime) && TIME_RE.test(endTime) && endTime <= startTime) {
        nextErrors.endTime = 'End time must be after start time.';
      }
    }

    if (mode === 'routine') {
      if (selectedDays.length === 0) nextErrors.daysOfWeek = 'Select at least one active day.';
      if (!TIME_RE.test(routineTime) && !routineBlock) nextErrors.timeIntent = 'Set a routine time or a time block.';
      if (routineTime && !TIME_RE.test(routineTime)) nextErrors.timeIntent = 'Routine time must use HH:MM.';
    }

    if (mode === 'recurring_todo') {
      if (presetNeedsDayPicker(recurPreset) && selectedDays.length === 0) {
        nextErrors.daysOfWeek = 'Select at least one active day.';
      }
    }

    setErrors(nextErrors);
    return !Object.values(nextErrors).some(Boolean);
  };

  const handleSave = () => {
    if (!validate()) {
      return;
    }

    if (mode === 'appointment' || mode === 'time_block') {
      const payload: ManualOrbitEventInput = {
        title: title.trim(),
        dateKey,
        startTime,
        endTime,
        cal: mode === 'appointment' ? 'MANUAL' : 'BLOCK',
        eventType: mode === 'appointment' ? 'appointment' : 'time_block',
        notes: notes.trim() || undefined,
        // NEX-205: energy tag rides only on time_blocks (addManualOrbitEvent
        // also guards this).
        energy: mode === 'time_block' ? (energy ?? undefined) : undefined,
      };
      addManualOrbitEvent(payload);
    } else if (mode === 'routine') {
      addRecurringRule(title.trim(), selectedDays, routineTime || null, routineTime ? null : routineBlock, 'ROUTINE');
    } else if (mode === 'todo') {
      addDailyTask(title.trim(), dateKey);
    } else if (mode === 'recurring_todo') {
      // Preset → days/interval. Custom and weekly/biweekly/monthly use the
      // user-picked selectedDays; daily/weekdays/weekends use the preset's
      // canonical days.
      const days = presetNeedsDayPicker(recurPreset) ? selectedDays : presetToDays(recurPreset);
      const interval = recurPreset === 'custom' ? recurInterval : presetToInterval(recurPreset);
      addRecurringToDo(title.trim(), days, interval);
    }

    handleClose();
  };

  const needsDate = mode === 'appointment' || mode === 'time_block' || mode === 'todo';
  const needsTime = mode === 'appointment' || mode === 'time_block';
  const recurNeedsDays = mode === 'recurring_todo' && presetNeedsDayPicker(recurPreset);

  return (
    <Modal transparent animationType="slide" visible={visible} onRequestClose={handleClose}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}>
      <View style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={handleClose} />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <Text style={styles.header}>{titleLabel}</Text>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
            <View style={styles.modeRow}>
              {[
                { key: 'appointment', label: 'APPT' },
                { key: 'routine', label: 'ROUTINE' },
                { key: 'todo', label: 'TO-DO' },
                { key: 'recurring_todo', label: 'RECUR' },
                { key: 'time_block', label: 'BLOCK' },
              ].map((item) => {
                const active = mode === item.key;
                return (
                  <Pressable
                    key={item.key}
                    onPress={() => { setMode(item.key as OrbitManualAddMode); setShowDatePicker(false); setShowStartPicker(false); setShowEndPicker(false); }}
                    style={[styles.modeChip, active && styles.modeChipActive]}
                  >
                    <Text style={[styles.modeChipText, active && styles.modeChipTextActive]}>{item.label}</Text>
                  </Pressable>
                );
              })}
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>TITLE</Text>
              <TextInput
                value={title}
                onChangeText={setTitle}
                placeholder="Name this item"
                placeholderTextColor={PLACEHOLDER_COLOR}
                style={styles.input}
              />
              {!!errors.title && <Text style={styles.errorText}>{errors.title}</Text>}
            </View>

            {needsDate && (
              <View style={styles.fieldGroup}>
                <Text style={styles.label}>DATE</Text>
                <Pressable
                  style={styles.pickerButton}
                  onPress={() => { setShowDatePicker(!showDatePicker); setShowStartPicker(false); setShowEndPicker(false); }}
                >
                  <Text style={styles.pickerButtonText}>{formatDateLabel(dateKey)}</Text>
                  <Text style={styles.pickerChevron}>{showDatePicker ? '▲' : '▼'}</Text>
                </Pressable>
                {showDatePicker && (
                  <View style={styles.inlinePicker}>
                    <DateTimePicker
                      value={parseDateKey(dateKey)}
                      mode="date"
                      display="spinner"
                      themeVariant="dark"
                      textColor={DATE_PICKER_TEXT}
                      style={{ height: 120 }}
                      onChange={(_: any, date?: Date) => {
                        if (date) setDateKey(getLocalDateKey(date));
                      }}
                    />
                  </View>
                )}
                {!!errors.dateKey && <Text style={styles.errorText}>{errors.dateKey}</Text>}
              </View>
            )}

            {needsTime && (
              <View style={styles.timeRow}>
                <View style={styles.timeField}>
                  <Text style={styles.label}>START</Text>
                  <Pressable
                    style={styles.pickerButton}
                    onPress={() => { setShowStartPicker(!showStartPicker); setShowEndPicker(false); setShowDatePicker(false); }}
                  >
                    <Text style={styles.pickerButtonText}>{formatTimeLabel(startTime)}</Text>
                    <Text style={styles.pickerChevron}>{showStartPicker ? '▲' : '▼'}</Text>
                  </Pressable>
                  {showStartPicker && (
                    <View style={styles.inlinePicker}>
                      <DateTimePicker
                        value={parseTime(startTime, 9, 0)}
                        mode="time"
                        display="spinner"
                        themeVariant="dark"
                        textColor={DATE_PICKER_TEXT}
                        style={{ height: 120 }}
                        onChange={(_: any, date?: Date) => {
                          if (date) {
                            const hh = String(date.getHours()).padStart(2, '0');
                            const mm = String(date.getMinutes()).padStart(2, '0');
                            setStartTime(`${hh}:${mm}`);
                          }
                        }}
                      />
                    </View>
                  )}
                  {!!errors.startTime && <Text style={styles.errorText}>{errors.startTime}</Text>}
                </View>
                <View style={styles.timeField}>
                  <Text style={styles.label}>END</Text>
                  <Pressable
                    style={styles.pickerButton}
                    onPress={() => { setShowEndPicker(!showEndPicker); setShowStartPicker(false); setShowDatePicker(false); }}
                  >
                    <Text style={styles.pickerButtonText}>{formatTimeLabel(endTime)}</Text>
                    <Text style={styles.pickerChevron}>{showEndPicker ? '▲' : '▼'}</Text>
                  </Pressable>
                  {showEndPicker && (
                    <View style={styles.inlinePicker}>
                      <DateTimePicker
                        value={parseTime(endTime, 10, 0)}
                        mode="time"
                        display="spinner"
                        themeVariant="dark"
                        textColor={DATE_PICKER_TEXT}
                        style={{ height: 120 }}
                        onChange={(_: any, date?: Date) => {
                          if (date) {
                            const hh = String(date.getHours()).padStart(2, '0');
                            const mm = String(date.getMinutes()).padStart(2, '0');
                            setEndTime(`${hh}:${mm}`);
                          }
                        }}
                      />
                    </View>
                  )}
                  {!!errors.endTime && <Text style={styles.errorText}>{errors.endTime}</Text>}
                </View>
              </View>
            )}

            {mode === 'routine' && (
              <>
                <View style={styles.fieldGroup}>
                  <Text style={styles.label}>ACTIVE DAYS</Text>
                  <DayPicker
                      mode="multi"
                      value={selectedDays}
                      onChange={setSelectedDays}
                      label="Active days"
                    />
                  {!!errors.daysOfWeek && <Text style={styles.errorText}>{errors.daysOfWeek}</Text>}
                </View>

                <View style={styles.fieldGroup}>
                  <Text style={styles.label}>EXACT TIME (OPTIONAL)</Text>
                  {routineTime ? (
                    <View style={styles.routineTimeRow}>
                      <Pressable
                        style={[styles.pickerButton, { flex: 1 }]}
                        onPress={() => { setShowRoutineTimePicker(!showRoutineTimePicker); }}
                      >
                        <Text style={styles.pickerButtonText}>{formatTimeLabel(routineTime)}</Text>
                        <Text style={styles.pickerChevron}>{showRoutineTimePicker ? '▲' : '▼'}</Text>
                      </Pressable>
                      <Pressable onPress={() => { setRoutineTime(''); setShowRoutineTimePicker(false); }} hitSlop={6} style={styles.clearButton} accessibilityRole="button" accessibilityLabel="Clear routine time">
                        <Text style={styles.clearButtonText} accessibilityElementsHidden importantForAccessibility="no">✕</Text>
                      </Pressable>
                    </View>
                  ) : (
                    <Pressable onPress={() => { setRoutineTime('17:00'); setRoutineBlock(null); setShowRoutineTimePicker(true); }} style={styles.pickerButton}>
                      {/* FIXME(nex-56): off-scale gray placeholder + off-scale 14pt fontSize, design review */}
                      <Text style={{ color: PLACEHOLDER_COLOR, fontSize: 14 }}>Tap to set time</Text>
                    </Pressable>
                  )}
                  {showRoutineTimePicker && routineTime && (
                    <View style={styles.inlinePicker}>
                      <DateTimePicker
                        value={parseTime(routineTime, 17, 0)}
                        mode="time"
                        display="spinner"
                        themeVariant="dark"
                        textColor={DATE_PICKER_TEXT}
                        style={{ height: 120 }}
                        onChange={(_: any, date?: Date) => {
                          if (date) {
                            const hh = String(date.getHours()).padStart(2, '0');
                            const mm = String(date.getMinutes()).padStart(2, '0');
                            setRoutineTime(`${hh}:${mm}`);
                            setRoutineBlock(null);
                          }
                        }}
                      />
                    </View>
                  )}
                </View>

                <View style={styles.fieldGroup}>
                  <Text style={styles.label}>OR USE TIME BLOCK</Text>
                  <View style={styles.blockRow}>
                    {TIME_BLOCKS.map((block) => {
                      const active = routineBlock === block;
                      return (
                        <Pressable
                          key={block}
                          onPress={() => {
                            setRoutineTime('');
                            setShowRoutineTimePicker(false);
                            toggleRoutineBlock(block);
                          }}
                          style={[styles.blockChip, active && styles.blockChipActive]}
                        >
                          <Text style={[styles.blockChipText, active && styles.blockChipTextActive]}>{block.toUpperCase()}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                  {!!errors.timeIntent && <Text style={styles.errorText}>{errors.timeIntent}</Text>}
                </View>
              </>
            )}

            {mode === 'recurring_todo' && (
              <>
                <View style={styles.fieldGroup}>
                  <Text style={styles.label}>HOW OFTEN</Text>
                  <View style={styles.presetCol}>
                    {RECURRENCE_PRESETS.map((p) => {
                      const active = recurPreset === p.id;
                      return (
                        <Pressable
                          key={p.id}
                          onPress={() => {
                            haptic('buttonSecondary');
                            // (preset select)
                            setRecurPreset(p.id);
                            // Daily / Weekdays / Weekends fully specify days;
                            // others let the user pick below.
                            if (!presetNeedsDayPicker(p.id)) {
                              setSelectedDays(presetToDays(p.id));
                            } else if (selectedDays.length === 0) {
                              // Seed today's day-of-week as a sensible default
                              // for weekly/biweekly/monthly.
                              setSelectedDays([new Date().getDay()]);
                            }
                            if (p.id !== 'custom') setRecurInterval(presetToInterval(p.id));
                          }}
                          style={[styles.presetRow, active && styles.presetRowActive]}
                        >
                          <View style={{ flex: 1 }}>
                            <Text style={[styles.presetLabel, active && styles.presetLabelActive]}>{p.label}</Text>
                            <Text style={styles.presetSub}>{p.sub}</Text>
                          </View>
                          {active && <Text style={styles.presetCheck}>✓</Text>}
                        </Pressable>
                      );
                    })}
                  </View>
                </View>

                {recurNeedsDays && (
                  <View style={styles.fieldGroup}>
                    <Text style={styles.label}>ACTIVE DAYS</Text>
                    <DayPicker
                      mode="multi"
                      value={selectedDays}
                      onChange={setSelectedDays}
                      label="Active days"
                    />
                    {!!errors.daysOfWeek && <Text style={styles.errorText}>{errors.daysOfWeek}</Text>}
                  </View>
                )}

                {recurPreset === 'custom' && (
                  <View style={styles.fieldGroup}>
                    <Text style={styles.label}>EVERY N WEEKS</Text>
                    <View style={styles.intervalRow}>
                      {[1, 2, 3, 4, 6, 8, 12].map((n) => (
                        <Pressable
                          key={n}
                          onPress={() => { haptic('buttonSecondary'); setRecurInterval(n); }}
                          style={[styles.intervalBtn, recurInterval === n && styles.intervalBtnActive]}
                        >
                          <Text style={[styles.intervalText, recurInterval === n && styles.intervalTextActive]}>{n}</Text>
                        </Pressable>
                      ))}
                    </View>
                  </View>
                )}
              </>
            )}

            {needsTime && (
              <View style={styles.fieldGroup}>
                <Text style={styles.label}>NOTES (OPTIONAL)</Text>
                <TextInput
                  value={notes}
                  onChangeText={setNotes}
                  placeholder="Context, location, details..."
                  placeholderTextColor={PLACEHOLDER_COLOR}
                  multiline
                  style={[styles.input, styles.notesInput]}
                />
              </View>
            )}

            {/* NEX-205 (Or-2): optional energy tag — time-blocks only. Shapes the
                block by energy over clock precision. Single-select, deselectable. */}
            {mode === 'time_block' && (
              <View style={styles.fieldGroup}>
                <Text style={styles.label}>ENERGY (OPTIONAL)</Text>
                <View style={styles.blockRow}>
                  {ENERGY_TAGS.map((tag) => {
                    const active = energy === tag;
                    return (
                      <Pressable
                        key={tag}
                        onPress={() => { haptic('buttonSecondary'); setEnergy(active ? null : tag); }}
                        style={[styles.blockChip, active && styles.blockChipActive]}
                        accessibilityRole="button"
                        accessibilityState={{ selected: active }}
                        accessibilityLabel={`${tag} energy`}
                      >
                        <Text style={[styles.blockChipText, active && styles.blockChipTextActive]}>{tag.toUpperCase()}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            )}
          </ScrollView>

          <View style={styles.footerRow}>
            <Pressable style={styles.secondaryButton} onPress={handleClose}>
              <Text style={styles.secondaryButtonText}>CANCEL</Text>
            </Pressable>
            <PrimaryPill fullWidth style={{ flex: 1 }} onPress={handleSave}>
              SAVE
            </PrimaryPill>
          </View>
        </View>
      </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export default OrbitManualAddSheet;

const styles = StyleSheet.create({
  // FIXME(nex-56): black-alpha overlay, no token — design review
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  backdrop: { ...StyleSheet.absoluteFillObject },
  // FIXME(nex-56): off-scale 18/12/22 padding + 28 radius — design review
  sheet: {
    backgroundColor: tokens.color.surfaceElevated,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderWidth: 1,
    borderColor: tokens.color.goldHairline,
    paddingHorizontal: 18,
    paddingTop: tokens.spacing.sm,
    paddingBottom: 22,
    maxHeight: '80%',
  },
  handle: {
    width: 56,
    height: 5,
    borderRadius: 999,
    backgroundColor: tokens.color.surfaceElevated,
    alignSelf: 'center',
    marginBottom: tokens.spacing.sm,
  },
  // FIXME(nex-56): off-scale 11pt fontSize + 14pt margin — design review
  header: {
    color: tokens.color.gold,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 3,
    textAlign: 'center',
    marginBottom: 14,
  },
  // FIXME(nex-56): off-scale 10pt paddingBottom — design review
  scrollContent: { paddingBottom: 10 },
  // FIXME(nex-56): off-scale 14pt margin — design review
  modeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: tokens.spacing.xs, marginBottom: 14 },
  modeChip: {
    backgroundColor: tokens.color.void,
    borderWidth: 1,
    borderColor: tokens.color.goldHairline,
    borderRadius: 999,
    // FIXME(nex-56): off-scale 14pt paddingHorizontal — design review
    paddingHorizontal: 14,
    paddingVertical: tokens.spacing.xs,
  },
  modeChipActive: { backgroundColor: tokens.color.gold, borderColor: tokens.color.gold },
  modeChipText: { color: tokens.color.textMuted, fontSize: 10, fontWeight: '900', letterSpacing: 1.4 },
  modeChipTextActive: { color: tokens.color.textInverse },
  fieldGroup: { marginBottom: tokens.spacing.sm },
  label: { color: tokens.color.textMuted, fontSize: 9, fontWeight: '900', letterSpacing: 1.4, marginBottom: 6 },
  input: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: tokens.color.goldHairline,
    backgroundColor: tokens.color.void,
    color: tokens.color.text,
    // FIXME(nex-56): off-scale 14pt fontSize — design review
    fontSize: 14,
    // FIXME(nex-56): off-scale 14pt paddingHorizontal + 11pt paddingVertical — design review
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  // FIXME(nex-56): off-scale 70pt minHeight — design review
  notesInput: { minHeight: 70, textAlignVertical: 'top' },
  pickerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: tokens.color.goldHairline,
    backgroundColor: tokens.color.void,
    // FIXME(nex-56): off-scale 14pt paddingHorizontal — design review
    paddingHorizontal: 14,
    paddingVertical: tokens.spacing.sm,
  },
  // FIXME(nex-56): off-scale 14pt fontSize — design review
  pickerButtonText: { color: tokens.color.text, fontSize: 14, fontWeight: '600' },
  pickerChevron: { color: tokens.color.textMuted, fontSize: 10 },
  inlinePicker: {
    marginTop: 6,
    backgroundColor: tokens.color.void,
    borderRadius: 12,
    overflow: 'hidden',
  },
  errorText: { color: tokens.color.stateError, fontSize: 11, marginTop: tokens.spacing.xxs, fontWeight: '600' },
  // FIXME(nex-56): off-scale gap 10 + 12pt margin — design review
  timeRow: { flexDirection: 'row', gap: 10, marginBottom: tokens.spacing.sm },
  timeField: { flex: 1 },
  routineTimeRow: { flexDirection: 'row', gap: tokens.spacing.xs, alignItems: 'center' },
  clearButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: tokens.color.goldHairline,
    borderWidth: 1,
    borderColor: tokens.color.textDisabled,
    justifyContent: 'center',
    alignItems: 'center',
  },
  clearButtonText: { color: tokens.color.textMuted, fontSize: 14, fontWeight: '700' },
  blockRow: { flexDirection: 'row', flexWrap: 'wrap', gap: tokens.spacing.xs },
  blockChip: {
    paddingVertical: tokens.spacing.xs,
    paddingHorizontal: tokens.spacing.sm,
    borderRadius: 999,
    backgroundColor: tokens.color.void,
    borderWidth: 1,
    borderColor: tokens.color.goldHairline,
  },
  blockChipActive: { backgroundColor: tokens.color.gold, borderColor: tokens.color.gold },
  blockChipText: { color: tokens.color.textMuted, fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  blockChipTextActive: { color: tokens.color.textInverse },
  presetCol: { gap: 6 },
  presetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: tokens.color.void,
    borderWidth: 1,
    borderColor: tokens.color.goldHairline,
    borderRadius: 12,
    // FIXME(nex-56): off-scale 14pt paddingHorizontal + 10pt paddingVertical — design review
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  presetRowActive: { borderColor: tokens.color.gold, backgroundColor: tokens.color.goldWash },
  // FIXME(nex-56): off-scale 14pt fontSize — design review
  presetLabel: { color: tokens.color.text, fontSize: 14, fontWeight: '600' },
  presetLabelActive: { color: tokens.color.gold },
  presetSub: { color: tokens.color.textMuted, fontSize: 11, marginTop: 2 },
  // FIXME(nex-56): off-scale 16pt fontSize — design review
  presetCheck: { color: tokens.color.gold, fontSize: 16, fontWeight: '900', marginLeft: tokens.spacing.xs },
  intervalRow: { flexDirection: 'row', flexWrap: 'wrap', gap: tokens.spacing.xs },
  intervalBtn: {
    minWidth: 44,
    // FIXME(nex-56): off-scale 10pt paddingVertical + 12pt paddingHorizontal — design review
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: tokens.color.void,
    borderWidth: 1,
    borderColor: tokens.color.goldHairline,
    alignItems: 'center',
  },
  intervalBtnActive: { backgroundColor: tokens.color.goldWash, borderColor: tokens.color.gold },
  intervalText: { color: tokens.color.textMuted, fontSize: 13, fontWeight: '700' },
  intervalTextActive: { color: tokens.color.gold },
  footerRow: { flexDirection: 'row', gap: tokens.spacing.sm, marginTop: 6 },
  secondaryButton: {
    flex: 1,
    backgroundColor: tokens.color.surface,
    borderRadius: 14,
    // FIXME(nex-56): off-scale 13pt paddingVertical — design review
    paddingVertical: 13,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: tokens.color.goldHairline,
  },
  secondaryButtonText: { color: tokens.color.textSecondary, fontSize: 11, fontWeight: '900', letterSpacing: 1.5 },
});
