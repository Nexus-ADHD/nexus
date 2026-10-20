/**
 * CommandReviewCard
 *
 * The plan on the table: what the coach proposes, before anything is
 * written. One row per action. Tap a row to open it in the editor sheet
 * (every field visible, keyboard only on request); tap the row's remove
 * control to drop it. Confirm writes the whole plan through the executor.
 *
 * 2026-09-03 rebuild after the founder's first real session: the inline
 * autofocus title input ("rigid, jumpy") and the 420pt nested ScrollView are
 * gone; rows lay out in the thread and the thread scrolls. A remove control
 * is visible on every row (§19: no swipe-to-delete as the primary destructive
 * action, and no gesture-hidden surface). Removing the last row dismisses
 * the plan.
 */

import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { MotiView } from 'moti';
import { SymbolView } from 'expo-symbols';
import tokens from '../../theme/tokens';
import { haptic } from '../../utils/haptics';
import { PrimaryPill } from '../../components/ui/PrimaryPill';
import { IconButton } from '../../components/ui/IconButton';
import { stripEmoji } from '../../utils/text';
import { useEntranceFrom } from '@/hooks/use-entrance-motion';

import { ProposedAction, ProposedActionType } from './command-types';
import { getActionDestination, getActionTypeLabel, getActionTimingLabel } from './command-labels';
import { PlanItemEditorSheet } from './plan-item-editor-sheet';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CommandReviewCardProps {
  /** Actions the AI proposed, one row each. */
  proposedActions: ProposedAction[];
  /** Validation errors keyed by action index. */
  validationErrors: Record<number, string[]>;
  /** Called when the user confirms: passes the current (possibly edited) actions. */
  onConfirm: (actions: ProposedAction[]) => void;
  /** Called when the user cancels: should clear all proposal state. */
  onCancel: () => void;
  /** Called with a patch when the editor saves. Parent re-validates and re-keys. */
  onEditAction: (index: number, patch: Partial<ProposedAction>) => void;
  /** Called when a row is removed. Parent drops it (and the plan, when it was the last). */
  onRemoveAction: (index: number) => void;
  /** Disables Confirm while execution is in flight. */
  isExecuting?: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Action types that write somewhere the person will feel at once. */
const HIGH_TRUST_TYPES = new Set<ProposedActionType>(['calendar_add', 'recurring_add', 'recurring_todo_add', 'align']);

function isHighTrust(action: ProposedAction): boolean {
  return HIGH_TRUST_TYPES.has(action.type);
}

// ─── Row ─────────────────────────────────────────────────────────────────────

interface ActionRowProps {
  action: ProposedAction;
  errors: string[];
  onOpen: () => void;
  onRemove: () => void;
  disabled: boolean;
}

function ActionRow({ action, errors, onOpen, onRemove, disabled }: ActionRowProps) {
  const isInvalid = errors.length > 0;
  const timing = getActionTimingLabel(action);
  const displayTitle = action.type === 'recurring_add' ? stripEmoji(action.title) : action.title;

  return (
    <View style={[styles.row, isInvalid && styles.rowInvalid]}>
      <Pressable
        style={styles.rowBody}
        onPress={() => {
          haptic('buttonSecondary');
          onOpen();
        }}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`${displayTitle || 'Untitled'}, ${getActionTypeLabel(action)}${timing ? `, ${timing}` : ''}`}
        accessibilityHint="Opens the editor"
      >
        <View style={styles.rowHeader}>
          <Text style={styles.typeLabel}>{getActionTypeLabel(action).toUpperCase()}</Text>
          <Text style={styles.destination}>{getActionDestination(action)}</Text>
        </View>
        <Text style={styles.title} numberOfLines={3}>{displayTitle || 'Untitled'}</Text>
        {timing ? <Text style={styles.timing}>{timing}</Text> : null}
        {isHighTrust(action) ? <Text style={styles.trust}>Written when you confirm</Text> : null}
        {isInvalid ? (
          <View style={styles.errors}>
            {errors.map((err) => (
              <Text key={err} style={styles.errorText}>{err}</Text>
            ))}
          </View>
        ) : null}
      </Pressable>
      <IconButton
        icon={<SymbolView name="minus.circle" size={tokens.icon.size.md} tintColor={tokens.color.textSecondary} weight={tokens.icon.weight.default} />}
        onPress={onRemove}
        disabled={disabled}
        variant="ghost"
        accessibilityLabel={`Remove ${displayTitle || 'this item'} from the plan`}
      />
    </View>
  );
}

// ─── Card ────────────────────────────────────────────────────────────────────

export function CommandReviewCard({
  proposedActions,
  validationErrors,
  onConfirm,
  onCancel,
  onEditAction,
  onRemoveAction,
  isExecuting = false,
}: CommandReviewCardProps) {
  const hasErrors = Object.keys(validationErrors).length > 0;
  const canConfirm = !hasErrors && !isExecuting && proposedActions.length > 0;
  const entranceFrom = useEntranceFrom(20);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const editing = editingIndex !== null ? proposedActions[editingIndex] : undefined;

  const count = proposedActions.length;
  const headerLabel = count === 1 ? 'ONE THING, ONE TAP' : `${count} THINGS, ONE TAP`;

  return (
    <MotiView from={entranceFrom} animate={{ opacity: 1, translateY: 0 }} exit={{ opacity: 0, scale: 0.95 }} style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerLabel}>{headerLabel}</Text>
        <Text style={styles.headerHint}>Tap a row to change it. Remove what you will not do.</Text>
      </View>

      <View style={styles.rows}>
        {proposedActions.map((action, idx) => (
          <ActionRow
            key={`${action.type}-${idx}-${action.title}`}
            action={action}
            errors={validationErrors[idx] ?? []}
            onOpen={() => setEditingIndex(idx)}
            onRemove={() => {
              haptic('buttonSecondary');
              onRemoveAction(idx);
            }}
            disabled={isExecuting}
          />
        ))}
      </View>

      <View style={styles.footer}>
        <Pressable
          style={styles.cancelBtn}
          onPress={() => {
            haptic('buttonSecondary');
            onCancel();
          }}
          disabled={isExecuting}
          hitSlop={tokens.icon.hitTarget.linkSlopTight}
          accessibilityLabel="Cancel and clear the plan"
          accessibilityRole="button"
        >
          <Text style={styles.cancelBtnText}>NOT NOW</Text>
        </Pressable>

        <PrimaryPill
          fullWidth
          style={styles.confirm}
          onPress={() => onConfirm(proposedActions)}
          disabled={!canConfirm}
          accessibilityLabel={isExecuting ? 'Adding to your day' : 'Add to your day'}
        >
          {isExecuting ? 'ADDING' : 'ADD TO MY DAY'}
        </PrimaryPill>
      </View>

      {hasErrors ? <Text style={styles.errorSummary}>Fix the rows above first.</Text> : null}

      {editing && editingIndex !== null ? (
        <PlanItemEditorSheet
          key={`${editingIndex}-${editing.title}`}
          action={editing}
          onSave={(patch) => {
            onEditAction(editingIndex, patch);
            setEditingIndex(null);
          }}
          onRemove={() => {
            const idx = editingIndex;
            setEditingIndex(null);
            onRemoveAction(idx);
          }}
          onDismiss={() => setEditingIndex(null)}
        />
      ) : null}
    </MotiView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    width: '100%',
    backgroundColor: tokens.color.surface,
    borderRadius: tokens.radii.xl,
    borderWidth: 1,
    borderColor: tokens.color.luminousEdge,
    overflow: 'hidden',
    marginTop: tokens.spacing.lg,
  },
  header: {
    paddingVertical: tokens.spacing.sm,
    paddingHorizontal: tokens.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: tokens.color.surfaceElevated,
    gap: tokens.spacing.xxs,
  },
  headerLabel: {
    ...tokens.type.labelTrackedSm,
    color: tokens.color.gold,
  },
  headerHint: {
    ...tokens.type.caption,
    color: tokens.color.textMuted,
  },
  rows: {
    paddingVertical: tokens.spacing.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: tokens.spacing.sm,
    marginVertical: tokens.spacing.xxs,
    borderRadius: tokens.radii.lg,
    borderWidth: 1,
    borderColor: tokens.color.goldHairline,
    paddingLeft: tokens.spacing.md,
    paddingRight: tokens.spacing.xxs,
  },
  rowInvalid: {
    borderColor: tokens.color.stateError,
  },
  rowBody: {
    flex: 1,
    paddingVertical: tokens.spacing.sm,
    gap: tokens.spacing.xxs,
  },
  rowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  typeLabel: {
    ...tokens.type.labelTrackedMicro,
    color: tokens.color.gold,
  },
  destination: {
    ...tokens.type.labelTrackedMicro,
    color: tokens.color.textMuted,
  },
  title: {
    ...tokens.type.bodyMdEmphasis,
    color: tokens.color.text,
  },
  timing: {
    ...tokens.type.caption,
    color: tokens.color.textSecondary,
  },
  trust: {
    ...tokens.type.caption,
    color: tokens.color.textMuted,
  },
  errors: {
    marginTop: tokens.spacing.xxs,
    gap: tokens.spacing.xxs,
  },
  errorText: {
    ...tokens.type.caption,
    color: tokens.color.stateError,
  },
  footer: {
    flexDirection: 'row',
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.md,
    gap: tokens.spacing.sm,
    borderTopWidth: 1,
    borderTopColor: tokens.color.surfaceElevated,
  },
  cancelBtn: {
    flex: 1,
    minHeight: 44,
    justifyContent: 'center',
    borderRadius: tokens.radii.lg,
    borderWidth: 1,
    borderColor: tokens.color.goldHairline,
    alignItems: 'center',
    backgroundColor: tokens.color.surface,
  },
  cancelBtnText: {
    ...tokens.type.buttonTracked,
    color: tokens.color.textMuted,
  },
  confirm: {
    flex: 2,
  },
  errorSummary: {
    ...tokens.type.caption,
    color: tokens.color.stateError,
    textAlign: 'center',
    paddingBottom: tokens.spacing.sm,
    paddingHorizontal: tokens.spacing.md,
  },
});
