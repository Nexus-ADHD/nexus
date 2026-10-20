import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';

import { haptic } from '@/src/utils/haptics';
import { PrimaryPill } from '@/src/components/ui/PrimaryPill';
import { Sheet } from '@/src/components/ui/Sheet';
import tokens from '@/src/theme/tokens';
import { useAppState } from '../../state/app-state';
import { getLocalDateKey } from '../../utils/recurrence';
import { computeActByDate } from '../../state/lead-time-types';

const PLACEHOLDER_COLOR = tokens.color.textMuted;
const DATE_PICKER_TEXT = tokens.color.text;

/** Pre-fill contract — shared so NEX-163 (weekly review) can open this with a
 *  manual OrbitEvent or a Google/Outlook event, not just an EventKit one. */
export interface LeadTimePrefill {
  title?: string;
  eventTitle?: string;
  eventDate?: string;      // YYYY-MM-DD; raw ISO is projected on open
  eventId?: string | null;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  prefill?: LeadTimePrefill | null;
}

const LEAD_PRESETS: { days: number; label: string }[] = [
  { days: 7, label: '1 WEEK' },
  { days: 14, label: '2 WEEKS' },
  { days: 21, label: '3 WEEKS' },
  { days: 30, label: '1 MONTH' },
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function parseDateKey(dk: string): Date {
  const p = dk.split('-');
  if (p.length === 3) {
    const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12, 0, 0, 0);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

function formatLong(dk: string): string {
  const d = parseDateKey(dk);
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** A standalone default event date three weeks out — recomputed on each open so
 *  a long-lived (always-mounted) sheet never seeds a stale "today + 21". */
function freshDefaultEventKey(): string {
  const d = new Date();
  d.setDate(d.getDate() + 21);
  return getLocalDateKey(d);
}

export function LeadTimeCreateSheet({ visible, onClose, prefill }: Props) {
  const addLeadTimeAction = useAppState((s: any) => s.addLeadTimeAction);

  const [title, setTitle] = useState('');
  const [eventTitle, setEventTitle] = useState('');
  const [eventKey, setEventKey] = useState(freshDefaultEventKey);
  const [leadDays, setLeadDays] = useState(14);
  const [showPicker, setShowPicker] = useState(false);
  const [error, setError] = useState('');

  // Re-seed from the prefill ONLY on the closed→open transition — not on every
  // parent re-render while open (prefill is a fresh object each time), so a
  // re-render mid-edit can't clobber what the user has typed.
  const wasVisible = useRef(false);
  useEffect(() => {
    if (visible && !wasVisible.current) {
      setTitle(prefill?.title ?? '');
      setEventTitle(prefill?.eventTitle ?? '');
      setEventKey(prefill?.eventDate ? getLocalDateKey(prefill.eventDate) : freshDefaultEventKey());
      setLeadDays(14);
      setShowPicker(false);
      setError('');
    }
    wasVisible.current = visible;
  }, [visible, prefill]);

  const actByKey = useMemo(() => computeActByDate(eventKey, leadDays), [eventKey, leadDays]);

  const handleSave = () => {
    if (!title.trim()) { setError('Name the action you need to take.'); return; }
    if (!eventTitle.trim()) { setError('Name the event it leads up to.'); return; }
    addLeadTimeAction({
      title: title.trim(),
      eventTitle: eventTitle.trim(),
      eventDate: eventKey,
      leadDays,
      eventId: prefill?.eventId ?? null,
    });
    onClose();
  };

  return (
    <Sheet visible={visible} onDismiss={onClose} accessibilityLabel="Create lead time">
      <Text style={styles.header}>LEAD TIME</Text>

      <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <View style={styles.fieldGroup}>
          <Text style={styles.label}>WHAT NEEDS DOING</Text>
          <TextInput
            value={title}
            onChangeText={(t) => { setTitle(t); if (error) setError(''); }}
            placeholder="Request the day off"
            placeholderTextColor={PLACEHOLDER_COLOR}
            autoFocus={!prefill?.title}
            style={styles.input}
            returnKeyType="next"
          />
        </View>

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>FOR WHAT EVENT</Text>
          <TextInput
            value={eventTitle}
            onChangeText={(t) => { setEventTitle(t); if (error) setError(''); }}
            placeholder="Sean's wedding"
            placeholderTextColor={PLACEHOLDER_COLOR}
            style={styles.input}
          />
        </View>

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>EVENT DATE</Text>
          <Pressable style={styles.pickerButton} onPress={() => setShowPicker((v) => !v)}>
            <Text style={styles.pickerButtonText}>{formatLong(eventKey)}</Text>
            <Text style={styles.pickerChevron}>{showPicker ? '▲' : '▼'}</Text>
          </Pressable>
          {showPicker && (
            <View style={styles.inlinePicker}>
              <DateTimePicker
                value={parseDateKey(eventKey)}
                mode="date"
                display="spinner"
                themeVariant="dark"
                textColor={DATE_PICKER_TEXT}
                style={{ height: 120 }}
                onChange={(_: any, date?: Date) => { if (date) setEventKey(getLocalDateKey(date)); }}
              />
            </View>
          )}
        </View>

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>ACT THIS FAR AHEAD</Text>
          <View style={styles.presetRow}>
            {LEAD_PRESETS.map((p) => {
              const active = leadDays === p.days;
              return (
                <Pressable
                  key={p.days}
                  onPress={() => { haptic('buttonSecondary'); setLeadDays(p.days); }}
                  style={[styles.presetChip, active && styles.presetChipActive]}
                >
                  <Text style={[styles.presetChipText, active && styles.presetChipTextActive]}>{p.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={styles.actByCard}>
          <Text style={styles.actByLabel}>ACT BY</Text>
          <Text style={styles.actByDate}>{formatLong(actByKey)}</Text>
        </View>

        {!!error && <Text style={styles.errorText}>{error}</Text>}
      </ScrollView>

      <View style={styles.footerRow}>
        <Pressable style={styles.secondaryButton} onPress={onClose}>
          <Text style={styles.secondaryButtonText}>CANCEL</Text>
        </Pressable>
        <PrimaryPill fullWidth style={{ flex: 1 }} onPress={handleSave}>
          SET LEAD TIME
        </PrimaryPill>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  header: { color: tokens.color.gold, fontSize: 11, fontWeight: '900', letterSpacing: 3, textAlign: 'center', marginBottom: 16 },
  fieldGroup: { marginBottom: tokens.spacing.md },
  label: { color: tokens.color.textMuted, fontSize: 9, fontWeight: '900', letterSpacing: 1.4, marginBottom: 6 },
  input: {
    borderRadius: 14, borderWidth: 1, borderColor: tokens.color.goldHairline,
    backgroundColor: tokens.color.void, color: tokens.color.text, fontSize: 15,
    paddingHorizontal: 14, paddingVertical: 12,
  },
  pickerButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    borderRadius: 14, borderWidth: 1, borderColor: tokens.color.goldHairline,
    backgroundColor: tokens.color.void, paddingHorizontal: 14, paddingVertical: tokens.spacing.sm,
  },
  pickerButtonText: { color: tokens.color.text, fontSize: 15, fontWeight: '600' },
  pickerChevron: { color: tokens.color.textMuted, fontSize: 10 },
  inlinePicker: { marginTop: 6, backgroundColor: tokens.color.void, borderRadius: 12, overflow: 'hidden' },
  presetRow: { flexDirection: 'row', flexWrap: 'wrap', gap: tokens.spacing.xs },
  presetChip: {
    paddingHorizontal: 14, paddingVertical: tokens.spacing.xs, borderRadius: 999,
    backgroundColor: tokens.color.void, borderWidth: 1, borderColor: tokens.color.goldHairline,
  },
  presetChipActive: { backgroundColor: tokens.color.teal, borderColor: tokens.color.teal },
  presetChipText: { color: tokens.color.textMuted, fontSize: 10, fontWeight: '900', letterSpacing: 1.2 },
  presetChipTextActive: { color: tokens.color.textInverse },
  actByCard: {
    flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between',
    backgroundColor: tokens.color.surface, borderRadius: 14, borderWidth: 1,
    borderColor: tokens.color.goldHairline, paddingHorizontal: 16, paddingVertical: 14, marginTop: tokens.spacing.xs,
  },
  actByLabel: { color: tokens.color.gold, fontSize: 10, fontWeight: '900', letterSpacing: 2 },
  actByDate: { color: tokens.color.text, fontSize: 16, fontWeight: '700', fontVariant: ['tabular-nums'] },
  errorText: { color: tokens.color.stateError, fontSize: 12, marginTop: tokens.spacing.sm, fontWeight: '600' },
  footerRow: { flexDirection: 'row', gap: tokens.spacing.sm, marginTop: tokens.spacing.md },
  secondaryButton: {
    flex: 1, backgroundColor: tokens.color.surface, borderRadius: 14, paddingVertical: 14,
    alignItems: 'center', borderWidth: 1, borderColor: tokens.color.goldHairline,
  },
  secondaryButtonText: { color: tokens.color.textSecondary, fontSize: 11, fontWeight: '900', letterSpacing: 1.5 },
});
