/**
 * ManageHabitsModal — habit management surface (NEX-54).
 *
 * Two internal views in one Modal (no nested Modal — Codex):
 *   - LIST: tap a habit to edit; PIN is an isolated row quick-action; "+ New
 *     habit" opens create.
 *   - EDIT/CREATE: the focused HabitEditView (name autofocus, day pills,
 *     times/day, valid-only Save, in-sheet delete).
 *
 * Launched from Home ("MANAGE") and Orbit. Pulls state from the global store.
 */

import React, { useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';

import { useAppState } from '../state/app-state';
import { useShallow } from 'zustand/react/shallow';
import { haptic } from '../utils/haptics';
import { PrimaryPill } from './ui/PrimaryPill';
import { Sheet } from '@/src/components/ui/Sheet';
import { stripEmoji } from '../utils/text';
import { computeLifetimeReps } from '@/src/state/selectors/habit-rollup';
import tokens from '@/src/theme/tokens';
import { Toggle } from '@/src/components/ui/Toggle';
import { HabitEditView } from './habit-edit-view';

const GOLD = tokens.color.gold;
const TEXT = tokens.color.text;
const MUTED = tokens.color.textMuted;

interface Props {
  visible: boolean;
  onDismiss: () => void;
}

// editing: null = list view, 'new' = create, <id> = edit that habit.
type Editing = null | 'new' | string;

export function ManageHabitsModal({ visible, onDismiss }: Props) {
  const { recurringRules, getStreak, habitLog, softMode, setSoftMode, setHabitExcludedFromScore } = useAppState(
    useShallow((s: any) => ({
      recurringRules: s.recurringRules,
      getStreak: s.getStreak,
      habitLog: s.habitLog,
      softMode: s.softMode,
      setSoftMode: s.setSoftMode,
      setHabitExcludedFromScore: s.setHabitExcludedFromScore,
    })),
  );
  const [editing, setEditing] = useState<Editing>(null);

  const handleClose = () => {
    setEditing(null);
    onDismiss();
  };

  return (
    <Sheet
      visible={visible}
      onDismiss={handleClose}
      // Tapping away is fine on the list, but it would silently discard an
      // in-progress habit edit, so it is only offered when nothing is open.
      dismissOnBackdropPress={editing === null}
      accessibilityLabel="Manage habits"
    >
      {editing !== null ? (
        <HabitEditView
          habitId={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : (
        <>
          <Text style={styles.modalTitle}>MANAGE HABITS</Text>
          <Text style={styles.modalSubtitle}>Tap a habit to edit. Rest one to drop it from today’s score.</Text>

          <ScrollView showsVerticalScrollIndicator={false} style={{ maxHeight: 360 }} keyboardShouldPersistTaps="handled">
            {/* NEX-perf: Home keeps this sheet mounted even while closed
                (visible={false}), so gate the per-rule mapping on `visible` —
                otherwise every closed render pays a getStreak +
                computeLifetimeReps scan, and the latter walks the FULL
                habitLog per rule. When open the list is identical. */}
            {Array.isArray(recurringRules) && recurringRules.length > 0 ? (
              (visible ? recurringRules : []).map((rule: any) => {
                const excluded = rule.excludedFromScore === true;
                const streak = getStreak ? getStreak(rule.title) : 0;
                // NEX-190: cumulative reps by default (a miss takes none away);
                // the breakable day-streak shows only in opt-in Soft Mode.
                const reps = computeLifetimeReps(rule, habitLog);
                const dayCount = Array.isArray(rule.daysOfWeek) ? rule.daysOfWeek.length : 0;
                const progressMeta = softMode
                  ? (streak >= 2 ? `  ·  ${streak}d streak` : '')
                  : (reps > 0 ? `  ·  ${reps} reps` : '');
                const meta =
                  (dayCount === 7 || dayCount === 0 ? 'Daily' : `${dayCount}x/week`) +
                  ((rule.timesPerDay || 1) > 1 ? `  ·  ${rule.timesPerDay}x/day` : '') +
                  progressMeta;
                return (
                  <Pressable key={rule.id} style={styles.row} onPress={() => setEditing(rule.id)}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.habitTitle}>{stripEmoji(rule.title)}</Text>
                      <Text style={styles.habitMeta}>{meta}</Text>
                    </View>
                    {/* Isolated press target — toggles whether the habit
                        counts toward today's score, and does NOT open the
                        editor (RN inner Pressable captures the tap). */}
                    <Pressable
                      onPress={() => setHabitExcludedFromScore?.(rule.id, !excluded)}
                      style={[styles.pinBtn, !excluded && styles.pinBtnActive]}
                    >
                      <Text style={[styles.pinBtnText, !excluded && { color: tokens.color.textInverse }]}>
                        {excluded ? 'RESTING' : 'ACTIVE'}
                      </Text>
                    </Pressable>
                    <Text style={styles.chevron}>{'›'}</Text>
                  </Pressable>
                );
              })
            ) : (
              <Text style={[styles.mutedText, { textAlign: 'center', marginTop: tokens.spacing.lg }]}>
                No habits yet — add your first below.
              </Text>
            )}

            {/* NEX-218: Soft Mode lives at the FOOTER of the scrollable habit
                list — where streaks appear — so it adds no fixed chrome height
                and can never push the modal's actions off a small screen. This
                is NOT a cosmetic display flip: it turns on a breakable
                day-streak (§1.5 Law B/E), so the copy is honest, opt-in, and
                reversible, and never implies the cumulative reps were "less
                real." Avoids the word "Pause" (used above for per-habit score
                exclusion). Both this and Settings write the same `softMode` —
                single source of truth. */}
            <View style={styles.softModeRow}>
              <View style={{ flex: 1, marginRight: tokens.spacing.md }}>
                <Text style={styles.softModeTitle}>Show a breakable day streak</Text>
                <Text style={styles.softModeSub}>
                  Off by default. Your progress stays cumulative and a miss takes nothing away.
                  Soft Mode shows a day count with one free miss. You can switch back anytime.
                </Text>
              </View>
              <Toggle
                value={!!softMode}
                onValueChange={(v) => setSoftMode?.(v)}
                accessibilityLabel="Show a breakable day streak"
              />
            </View>
          </ScrollView>

          <Pressable style={styles.newHabitBtn} onPress={() => setEditing('new')}>
            <Text style={styles.newHabitBtnText}>+ New habit</Text>
          </Pressable>

          <PrimaryPill fullWidth style={{ marginTop: tokens.spacing.sm }} onPress={handleClose}>
            DONE
          </PrimaryPill>
        </>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  modalTitle: { color: GOLD, fontSize: 12, fontWeight: '900', letterSpacing: 4, textAlign: 'center', marginBottom: 6 },
  modalSubtitle: { color: MUTED, fontSize: 11, textAlign: 'center', marginBottom: 18 },

  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: tokens.spacing.md, borderBottomWidth: 1, borderBottomColor: tokens.color.surface },
  habitTitle: { color: TEXT, fontSize: 15, fontWeight: '600' },
  habitMeta: { color: MUTED, fontSize: 11, marginTop: 2 },
  pinBtn: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10, borderWidth: 1, borderColor: tokens.color.goldHairline, marginRight: tokens.spacing.sm },
  pinBtnActive: { backgroundColor: tokens.color.teal, borderColor: tokens.color.teal },
  pinBtnText: { color: MUTED, fontSize: 9, fontWeight: '900', letterSpacing: 1.5 },
  chevron: { color: MUTED, fontSize: 22, fontWeight: '300', lineHeight: 24 },

  softModeRow: { flexDirection: 'row', alignItems: 'center', paddingTop: tokens.spacing.md, marginTop: tokens.spacing.xs, borderTopWidth: 1, borderTopColor: tokens.color.goldHairline },
  softModeTitle: { color: TEXT, fontSize: 14, fontWeight: '600' },
  softModeSub: { color: MUTED, fontSize: 11, lineHeight: 16, marginTop: 3 },

  newHabitBtn: { borderRadius: 12, borderWidth: 1, borderColor: GOLD, paddingVertical: 12, alignItems: 'center', marginTop: 14, marginBottom: tokens.spacing.xxs },
  newHabitBtnText: { color: GOLD, fontSize: 12, fontWeight: '900', letterSpacing: 1.5 },

  mutedText: { color: MUTED, fontSize: 13 },
});
