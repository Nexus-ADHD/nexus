/**
 * HabitEditView — focused create/edit UI for one habit (NEX-54).
 *
 * Rendered as a VIEW swapped into ManageHabitsModal (NOT a nested Modal —
 * Codex: nested RN Modals bring brittle focus/dismissal). Create opens straight
 * into an auto-focused name field with daily preselected, so the only required
 * step is type-a-name + Save (research: setup friction is a top churn driver —
 * keep create one-tap-fast). Schedule + times are right there but optional.
 */
import React, { useMemo, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { useAppState, WEEKDAY_LABELS } from '../state/app-state';
import { useShallow } from 'zustand/react/shallow';
import { isDuplicateHabitTitle } from '../state/rule-edit';
import { normalize, stripEmoji } from '../utils/text';
import { HABIT_CUES } from './ui/cue-library';
import tokens from '@/src/theme/tokens';
import { DayPicker } from '@/src/components/ui/DayPicker';
import { PrimaryPill } from '@/src/components/ui/PrimaryPill';

const GOLD = tokens.color.gold;
const TEXT = tokens.color.text;
const MUTED = tokens.color.textMuted;
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

interface Props {
  /** null/undefined = create; a rule id = edit. */
  habitId: string | null;
  onClose: () => void;
}

export function HabitEditView({ habitId, onClose }: Props) {
  const {
    recurringRules,
    addRecurringRule,
    updateRecurringRule,
    deleteRecurringRule,
    setHabitExcludedFromScore,
    pillars,
    goalHabitMap,
  } = useAppState(
    useShallow((s: any) => ({
      recurringRules: s.recurringRules,
      addRecurringRule: s.addRecurringRule,
      updateRecurringRule: s.updateRecurringRule,
      deleteRecurringRule: s.deleteRecurringRule,
      setHabitExcludedFromScore: s.setHabitExcludedFromScore,
      pillars: s.pillars,
      goalHabitMap: s.goalHabitMap,
    })),
  );

  const isCreate = !habitId;
  const original = useMemo(
    () => (Array.isArray(recurringRules) ? recurringRules.find((r: any) => r.id === habitId) : null),
    [recurringRules, habitId],
  );

  const [name, setName] = useState<string>(original?.title ?? '');
  const [days, setDays] = useState<number[]>(
    Array.isArray(original?.daysOfWeek) && original.daysOfWeek.length > 0 ? [...original.daysOfWeek] : ALL_DAYS,
  );
  const [times, setTimes] = useState<number>(original?.timesPerDay ?? 1);
  // NEX-208: optional pre-framed "ridiculously small" first step (save-gated).
  const [firstStep, setFirstStep] = useState<string>(original?.firstStep ?? '');
  // NEX-171: score inclusion toggles immediately (independent of the save-gated
  // title/days/times form), mirroring the manage-list quick action.
  const [excluded, setExcluded] = useState<boolean>(original?.excludedFromScore === true);
  const nameRef = useRef<TextInput>(null);

  const toggleExcluded = () => {
    const next = !excluded;
    setExcluded(next);
    if (habitId) setHabitExcludedFromScore?.(habitId, next);
  };

  const trimmed = name.trim();
  const duplicate = isDuplicateHabitTitle(recurringRules, trimmed, habitId ?? undefined);
  const dirty =
    isCreate ||
    trimmed !== (original?.title ?? '').trim() ||
    times !== (original?.timesPerDay ?? 1) ||
    // NEX-208: a first-step-only edit must enable Save too.
    firstStep.trim() !== String(original?.firstStep ?? '').trim() ||
    JSON.stringify([...days].sort((a, b) => a - b)) !==
      JSON.stringify([...(original?.daysOfWeek ?? [])].sort((a, b) => a - b));
  const canSave = trimmed.length > 0 && days.length > 0 && !duplicate && dirty;

  // NEX-202: mandate echo anchor. Immediate write (not save-gated), driven off
  // the reactive `original`. The AI-linked pillar (goalHabitMap, AI-tainted) is
  // surfaced as a tappable SUGGESTED hint only — never pre-selected/auto-written.
  const anchorPillarId: string | null = original?.mandateEchoPillarId ?? null;
  const suggestedPillarId: string | null = useMemo(() => {
    if (isCreate || !original?.title) return null;
    // stripEmoji before normalize to match the dominant habit-key convention
    // (incompleteHabitsToday / log matching) so an emoji-titled habit's AI link
    // still surfaces the SUGGESTED hint (Greptile #211).
    const ids = (goalHabitMap ?? {})[normalize(stripEmoji(original.title))];
    return Array.isArray(ids) && ids.length > 0 ? ids[0] : null;
  }, [isCreate, original?.title, goalHabitMap]);
  const orderedMandates = useMemo(() => {
    const list: Array<{ id: string; title: string }> = Array.isArray(pillars) ? pillars : [];
    const priority = anchorPillarId ?? suggestedPillarId;
    if (!priority) return list;
    return [...list.filter((p) => p.id === priority), ...list.filter((p) => p.id !== priority)];
  }, [pillars, anchorPillarId, suggestedPillarId]);
  const anchorPillar =
    (Array.isArray(pillars) ? pillars : []).find((p: any) => p.id === anchorPillarId) ?? null;
  const showAnchorSection = !isCreate && Array.isArray(pillars) && pillars.length > 0;
  const setAnchor = (pillarId: string | null) => {
    if (habitId) updateRecurringRule(habitId, { mandateEchoPillarId: pillarId });
  };

  // NEX-209: optional if-then cue. Edit-mode only, immediate write (mirrors the
  // mandate anchor; distinct cue* identifiers, never the bare `anchor`). Blank
  // coerces to null. The legacy `anchor` field + its drift leverage stays dormant.
  const cueValue: string | null = original?.cue ?? null;
  const showCueSection = !isCreate;
  const setCue = (cue: string | null) => {
    if (habitId) updateRecurringRule(habitId, { cue: cue && cue.trim() ? cue.trim() : null });
  };

  const toggleDay = (idx: number) =>
    setDays((d) => (d.includes(idx) ? d.filter((x) => x !== idx) : [...d, idx].sort((a, b) => a - b)));

  const handleSave = () => {
    if (!canSave) return;
    const nextFirstStep = firstStep.trim() || null; // persist null, never ''
    if (isCreate) {
      // Single create call (no create-then-update double write).
      addRecurringRule(trimmed, days, null, null, 'PERSONAL', null, times, nextFirstStep);
    } else {
      updateRecurringRule(habitId, {
        title: trimmed,
        daysOfWeek: days,
        timesPerDay: times,
        firstStep: nextFirstStep,
      });
    }
    onClose();
  };

  const handleCancel = () => {
    // Create: silent discard. Edit: confirm only if the user changed something.
    if (!isCreate && dirty) {
      Alert.alert('Discard changes?', 'Your edits to this habit will not be saved.', [
        { text: 'Keep editing', style: 'cancel' },
        { text: 'Discard', style: 'destructive', onPress: onClose },
      ]);
      return;
    }
    onClose();
  };

  const handleDelete = () => {
    Alert.alert('Remove habit?', `Stop tracking "${trimmed || original?.title || 'this habit'}" and its history?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          if (deleteRecurringRule && habitId) deleteRecurringRule(habitId);
          onClose();
        },
      },
    ]);
  };

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.bodyContent}
    >
      <View style={styles.header}>
        <Pressable onPress={handleCancel} hitSlop={10}>
          <Text style={styles.cancelText}>{'‹ Back'}</Text>
        </Pressable>
        <Text style={styles.title}>{isCreate ? 'NEW HABIT' : 'EDIT HABIT'}</Text>
        <View style={{ width: 44 }} />
      </View>

      <TextInput
        ref={nameRef}
        style={styles.nameInput}
        placeholder="Name your habit"
        placeholderTextColor={MUTED}
        value={name}
        onChangeText={setName}
        autoFocus
        returnKeyType="done"
        onSubmitEditing={handleSave}
      />
      {duplicate ? <Text style={styles.dupHint}>A habit with this name already exists.</Text> : null}

      {/* NEX-208: optional pre-framed first step — lowers the initiation barrier
          and unlocks the ephemeral "started" acknowledgment on Home. */}
      <Text style={styles.fieldLabel}>FIRST STEP</Text>
      <TextInput
        style={styles.firstStepInput}
        placeholder="The smallest start that still counts as a start."
        placeholderTextColor={MUTED}
        value={firstStep}
        onChangeText={setFirstStep}
        returnKeyType="done"
      />

      <Text style={styles.fieldLabel}>REPEATS ON</Text>
      <DayPicker mode="multi" value={days} onChange={setDays} label="Repeats on" />

      <View style={styles.timesRow}>
        <Text style={styles.fieldLabel}>TIMES PER DAY</Text>
        <View style={styles.stepper}>
          <Pressable hitSlop={8} onPress={() => setTimes((t) => Math.max(1, t - 1))}>
            <Text style={[styles.stepBtn, { color: times > 1 ? GOLD : MUTED }]}>−</Text>
          </Pressable>
          <Text style={styles.stepValue}>{times}x</Text>
          <Pressable hitSlop={8} onPress={() => setTimes((t) => Math.min(6, t + 1))}>
            <Text style={[styles.stepBtn, { color: GOLD }]}>+</Text>
          </Pressable>
        </View>
      </View>

      {!isCreate ? (
        <View style={styles.timesRow}>
          <Text style={styles.fieldLabel}>COUNT TOWARD TODAY’S SCORE</Text>
          <Pressable
            hitSlop={8}
            onPress={toggleExcluded}
            style={[styles.togglePill, !excluded && styles.togglePillOn]}
          >
            <Text style={[styles.togglePillText, !excluded && { color: tokens.color.textInverse }]}>
              {excluded ? 'RESTING' : 'ON'}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {showCueSection ? (
        <View>
          <Text style={styles.fieldLabel}>WHEN / CUE</Text>
          {cueValue ? (
            <View style={styles.cueCurrent}>
              <Text style={styles.cueCurrentText} numberOfLines={2}>{cueValue}</Text>
              <Pressable
                onPress={() => setCue(null)}
                hitSlop={8}
                style={styles.cueRemoveBtn}
                accessibilityRole="button"
                accessibilityLabel="Remove the cue from this habit"
              >
                <Text style={styles.cueRemoveText}>REMOVE</Text>
              </Pressable>
            </View>
          ) : (
            <Text style={styles.cueHint}>The moment that triggers this habit.</Text>
          )}
          <View style={styles.cueChips}>
            {HABIT_CUES.map((c) => {
              const selected = c === cueValue;
              return (
                <Pressable
                  key={c}
                  onPress={() => setCue(selected ? null : c)}
                  style={[styles.cueChip, selected && styles.cueChipOn]}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                >
                  <Text style={[styles.cueChipText, selected && styles.cueChipTextOn]}>{c}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}

      {showAnchorSection ? (
        <View>
          <Text style={styles.fieldLabel}>ANCHOR TO A MANDATE</Text>
          {anchorPillar ? (
            <View style={styles.anchorCurrent}>
              <Text style={styles.anchorCurrentText} numberOfLines={2}>
                {stripEmoji(anchorPillar.title)}
              </Text>
              <Pressable
                onPress={() => setAnchor(null)}
                hitSlop={8}
                style={styles.anchorRemoveBtn}
                accessibilityRole="button"
                accessibilityLabel="Remove the mandate echo from this habit"
              >
                <Text style={styles.anchorRemoveText}>REMOVE</Text>
              </Pressable>
            </View>
          ) : (
            <Text style={styles.anchorHint}>
              An identity line that rides beneath this habit on Home.
            </Text>
          )}
          {/* NEX-209: a plain list now — the whole HabitEditView body is wrapped
              in a ScrollView (so two pickers + the form stay reachable), so the
              mandate library no longer needs its own nested ScrollView/bound. */}
          <View style={styles.anchorList}>
            {orderedMandates.map((p: any) => {
              const selected = p.id === anchorPillarId;
              const suggested = !selected && p.id === suggestedPillarId;
              return (
                <Pressable
                  key={p.id}
                  onPress={() => setAnchor(selected ? null : p.id)}
                  style={[styles.anchorOption, selected && styles.anchorOptionOn]}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                >
                  <Text
                    style={[styles.anchorOptionText, selected && styles.anchorOptionTextOn]}
                    numberOfLines={1}
                  >
                    {stripEmoji(p.title)}
                  </Text>
                  {suggested ? <Text style={styles.anchorSuggested}>SUGGESTED</Text> : null}
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}

      <PrimaryPill
        fullWidth
        style={{ marginTop: tokens.spacing.xl }}
        onPress={handleSave}
        disabled={!canSave}
      >
        {isCreate ? 'ADD HABIT' : 'SAVE'}
      </PrimaryPill>

      {!isCreate ? (
        <Pressable onPress={handleDelete} style={styles.deleteBtn} hitSlop={6}>
          <Text style={styles.deleteText}>REMOVE HABIT</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: tokens.spacing.md },
  title: { color: GOLD, fontSize: 12, fontWeight: '900', letterSpacing: 4 },
  cancelText: { color: MUTED, fontSize: 13, fontWeight: '700', width: 44 },
  nameInput: {
    backgroundColor: tokens.color.void,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: tokens.color.goldHairline,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
    color: TEXT,
    fontSize: 17,
    fontWeight: '600',
  },
  // NEX-208: lighter than the name input (it's optional + secondary).
  firstStepInput: {
    backgroundColor: tokens.color.void,
    borderRadius: tokens.radii.md,
    borderWidth: 1,
    borderColor: tokens.color.goldHairline,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
    color: TEXT,
    fontSize: tokens.type.bodyMd.fontSize,
  },
  dupHint: { color: tokens.color.stateError, fontSize: 12, marginTop: tokens.spacing.xs },
  fieldLabel: { color: MUTED, fontSize: 10, fontWeight: '900', letterSpacing: 2, marginTop: tokens.spacing.lg, marginBottom: tokens.spacing.sm },
  timesRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: tokens.spacing.md, marginTop: tokens.spacing.lg, marginBottom: tokens.spacing.sm },
  stepBtn: { fontSize: 22, fontWeight: '700', lineHeight: 26, minWidth: 20, textAlign: 'center' },
  stepValue: { color: GOLD, fontSize: 14, fontWeight: '900', minWidth: 28, textAlign: 'center' },
  togglePill: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 12, borderWidth: 1, borderColor: tokens.color.goldHairline, marginTop: tokens.spacing.lg },
  togglePillOn: { backgroundColor: tokens.color.teal, borderColor: tokens.color.teal },
  togglePillText: { color: MUTED, fontSize: 10, fontWeight: '900', letterSpacing: 1.5 },
  deleteBtn: { alignItems: 'center', paddingVertical: tokens.spacing.md, marginTop: tokens.spacing.xs },
  deleteText: { color: tokens.color.stateError, fontSize: 11, fontWeight: '900', letterSpacing: 1.5 },

  // NEX-202: anchor-to-a-mandate section. Fraunces italic for the mandate text
  // (identity voice); raw pill list for the picker (matches this file's register).
  anchorCurrent: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: tokens.spacing.sm,
    marginBottom: tokens.spacing.sm,
  },
  anchorCurrentText: {
    flex: 1,
    color: TEXT,
    fontSize: 15,
    lineHeight: 21,
    fontStyle: 'italic',
    fontFamily: 'Fraunces-LightItalic',
  },
  anchorRemoveBtn: { paddingVertical: 4, paddingHorizontal: 4 },
  anchorRemoveText: { color: tokens.color.stateError, fontSize: 10, fontWeight: '900', letterSpacing: 1.5 },
  anchorHint: { color: MUTED, fontSize: 12, lineHeight: 17, marginBottom: tokens.spacing.sm },
  anchorList: { gap: tokens.spacing.xs },
  anchorOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacing.sm,
    paddingVertical: tokens.spacing.sm,
    paddingHorizontal: tokens.spacing.md,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: tokens.color.goldHairline,
  },
  anchorOptionOn: { borderColor: GOLD, backgroundColor: tokens.color.goldWash },
  anchorOptionText: { flex: 1, color: MUTED, fontSize: 14 },
  anchorOptionTextOn: { color: TEXT },
  anchorSuggested: { color: GOLD, fontSize: 9, fontWeight: '900', letterSpacing: 1.5 },

  // NEX-209: cue section — teal (initiation), distinct from the mandate's gold.
  bodyContent: { paddingBottom: tokens.spacing.lg },
  cueCurrent: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: tokens.spacing.sm,
    marginBottom: tokens.spacing.sm,
  },
  cueCurrentText: { flex: 1, color: TEXT, fontSize: 15, lineHeight: 21 },
  cueRemoveBtn: { paddingVertical: 4, paddingHorizontal: 4 },
  cueRemoveText: { color: tokens.color.stateError, fontSize: 10, fontWeight: '900', letterSpacing: 1.5 },
  cueHint: { color: MUTED, fontSize: 12, lineHeight: 17, marginBottom: tokens.spacing.sm },
  cueChips: { flexDirection: 'row', flexWrap: 'wrap', gap: tokens.spacing.xs },
  cueChip: {
    paddingVertical: tokens.spacing.xs,
    paddingHorizontal: tokens.spacing.sm,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: tokens.color.goldHairline,
  },
  cueChipOn: { borderColor: tokens.color.teal, backgroundColor: tokens.color.tealWash },
  cueChipText: { color: MUTED, fontSize: 13 },
  cueChipTextOn: { color: tokens.color.teal },
});
