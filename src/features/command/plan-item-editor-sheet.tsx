/**
 * PlanItemEditorSheet
 *
 * The editor for one proposed action, opened from a plan card row. Replaces
 * the inline autofocus title input the founder called "rigid, jumpy": the
 * keyboard appears only when a field is tapped, every field of the item is
 * visible at once, and the sheet (the canonical overlay, §16) is
 * keyboard-aware so nothing is hidden behind the keys.
 *
 * Save writes a partial patch through the same `onEditAction` path the card
 * always used (the parent recomputes the proposal key). Remove drops the
 * item from the proposal; nothing has been written yet, so no undo is owed
 * (Law A: the plan is the proposal, Home is the write).
 */

import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import tokens from '../../theme/tokens';
import { haptic } from '../../utils/haptics';
import { Sheet } from '../../components/ui/Sheet';
import { PrimaryPill } from '../../components/ui/PrimaryPill';
import { SecondaryButton } from '../../components/ui/SecondaryButton';
import { DayPicker } from '../../components/ui/DayPicker';
import type { ProposedAction } from './command-types';
import { getActionDestination, getActionTypeLabel, getActionTimingLabel } from './command-labels';
import { TIME_BLOCKS, buildPatch, editableFieldsFor, type TimeBlock } from './plan-item-editor';

export interface PlanItemEditorSheetProps {
  action: ProposedAction;
  onSave: (patch: Partial<ProposedAction>) => void;
  onRemove: () => void;
  onDismiss: () => void;
}

export function PlanItemEditorSheet({ action, onSave, onRemove, onDismiss }: PlanItemEditorSheetProps) {
  const fields = editableFieldsFor(action.type);
  const [title, setTitle] = useState(action.title);
  const [time, setTime] = useState(action.time ?? '');
  const [dateStr, setDateStr] = useState(action.dateStr ?? '');
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>(action.daysOfWeek ?? []);
  const [preferredTimeBlock, setPreferredTimeBlock] = useState<TimeBlock | null>(action.preferredTimeBlock ?? null);
  const [description, setDescription] = useState(action.description ?? '');

  const { patch, errors } = useMemo(
    () => buildPatch(action, { title, time, dateStr, daysOfWeek, preferredTimeBlock, description }),
    [action, title, time, dateStr, daysOfWeek, preferredTimeBlock, description],
  );

  const save = () => {
    if (errors.length) return;
    haptic('buttonPrimary');
    onSave(patch);
  };
  const remove = () => {
    haptic('buttonSecondary');
    onRemove();
  };

  return (
    <Sheet accessibilityLabel={`Edit ${action.title}`} onDismiss={onDismiss} showHandle>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text style={styles.eyebrow}>{getActionTypeLabel(action).toUpperCase()}</Text>
          <Text style={styles.destination}>{getActionDestination(action)}</Text>
        </View>

        <Text style={styles.fieldLabel}>TITLE</Text>
        <TextInput
          style={styles.input}
          value={title}
          onChangeText={setTitle}
          maxLength={140}
          returnKeyType="done"
          accessibilityLabel="Title"
          placeholder="What it is"
          placeholderTextColor={tokens.color.textDisabled}
        />

        {fields.days ? (
          <View style={styles.field}>
            <DayPicker label="Days" mode="multi" value={daysOfWeek} onChange={setDaysOfWeek} />
          </View>
        ) : null}

        {fields.date ? (
          <>
            <Text style={styles.fieldLabel}>DATE</Text>
            <TextInput
              style={[styles.input, styles.mono]}
              value={dateStr}
              onChangeText={setDateStr}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={tokens.color.textDisabled}
              keyboardType="numbers-and-punctuation"
              maxLength={10}
              accessibilityLabel="Date"
            />
          </>
        ) : null}

        {fields.time ? (
          <>
            <Text style={styles.fieldLabel}>{fields.days ? 'TIME, OR A PART OF THE DAY' : 'TIME'}</Text>
            <TextInput
              style={[styles.input, styles.mono]}
              value={time}
              onChangeText={setTime}
              placeholder="HH:MM"
              placeholderTextColor={tokens.color.textDisabled}
              keyboardType="numbers-and-punctuation"
              maxLength={5}
              accessibilityLabel="Time, 24 hour"
            />
            {fields.days ? (
              <View style={styles.blocks} accessibilityRole="radiogroup" accessibilityLabel="Part of the day">
                {TIME_BLOCKS.map((block) => {
                  const on = !time.trim() && preferredTimeBlock === block;
                  return (
                    <Pressable
                      key={block}
                      onPress={() => {
                        haptic('buttonSecondary');
                        setTime('');
                        setPreferredTimeBlock(block);
                      }}
                      style={[styles.block, on && styles.blockOn]}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: on }}
                      accessibilityLabel={block}
                    >
                      <Text style={[styles.blockText, on && styles.blockTextOn]}>{block.toUpperCase()}</Text>
                    </Pressable>
                  );
                })}
              </View>
            ) : null}
          </>
        ) : null}

        {!fields.days && !fields.date && !fields.time && getActionTimingLabel(action) ? (
          <>
            <Text style={styles.fieldLabel}>WHEN</Text>
            <Text style={styles.readonly}>{getActionTimingLabel(action)}</Text>
          </>
        ) : null}

        {fields.note ? (
          <>
            <Text style={styles.fieldLabel}>NOTE</Text>
            <TextInput
              style={[styles.input, styles.multiline]}
              value={description}
              onChangeText={setDescription}
              multiline
              maxLength={500}
              accessibilityLabel="Note"
              placeholder="A link, a source, a line to remember"
              placeholderTextColor={tokens.color.textDisabled}
            />
          </>
        ) : null}

        {action.explanation ? <Text style={styles.explanation}>{action.explanation}</Text> : null}

        {errors.length ? (
          <View style={styles.errors} accessibilityLiveRegion="polite">
            {errors.map((e) => (
              <Text key={e} style={styles.errorText}>{e}</Text>
            ))}
          </View>
        ) : null}

        <View style={styles.actions}>
          <SecondaryButton onPress={remove} accessibilityLabel={`Remove ${action.title} from the plan`} style={styles.remove}>
            REMOVE
          </SecondaryButton>
          <PrimaryPill fullWidth style={styles.save} onPress={save} disabled={errors.length > 0} accessibilityLabel="Save changes">
            SAVE
          </PrimaryPill>
        </View>
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: tokens.spacing.lg,
    paddingTop: tokens.spacing.sm,
    paddingBottom: tokens.spacing.xl,
    gap: tokens.spacing.xs,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: tokens.spacing.sm,
  },
  eyebrow: {
    ...tokens.type.labelTrackedMicro,
    color: tokens.color.gold,
  },
  destination: {
    ...tokens.type.labelTrackedMicro,
    color: tokens.color.textMuted,
  },
  fieldLabel: {
    ...tokens.type.labelTrackedMicro,
    color: tokens.color.textMuted,
    marginTop: tokens.spacing.sm,
  },
  field: {
    marginTop: tokens.spacing.sm,
  },
  input: {
    ...tokens.type.bodyLg,
    color: tokens.color.text,
    borderBottomWidth: 1,
    borderBottomColor: tokens.color.luminousEdge,
    paddingVertical: tokens.spacing.xs,
  },
  mono: {
    fontFamily: tokens.font.plexMonoRegular,
  },
  multiline: {
    minHeight: 72,
    textAlignVertical: 'top',
  },
  readonly: {
    ...tokens.type.bodyMd,
    color: tokens.color.textSecondary,
    paddingVertical: tokens.spacing.xs,
  },
  blocks: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: tokens.spacing.xs,
    marginTop: tokens.spacing.xs,
  },
  block: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: tokens.spacing.md,
    borderRadius: tokens.radii.xxl,
    borderWidth: 1,
    borderColor: tokens.color.luminousEdge,
  },
  blockOn: {
    borderColor: tokens.color.teal,
  },
  blockText: {
    ...tokens.type.labelTrackedMicro,
    color: tokens.color.textSecondary,
  },
  blockTextOn: {
    color: tokens.color.teal,
  },
  explanation: {
    ...tokens.type.caption,
    color: tokens.color.textMuted,
    fontStyle: 'italic',
    marginTop: tokens.spacing.sm,
  },
  errors: {
    marginTop: tokens.spacing.sm,
    gap: tokens.spacing.xxs,
  },
  errorText: {
    ...tokens.type.caption,
    color: tokens.color.stateError,
  },
  actions: {
    flexDirection: 'row',
    gap: tokens.spacing.sm,
    marginTop: tokens.spacing.lg,
    alignItems: 'center',
  },
  remove: {
    flex: 1,
  },
  save: {
    flex: 2,
  },
});
