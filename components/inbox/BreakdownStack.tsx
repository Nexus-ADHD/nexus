// NEX-285 — Inbox breakdown stack.
//
// Renders one breakdown group (goal + its steps) as a single stacked card:
//   - collapsed: the goal label + progress (done/total) on the header, the current
//     step on top, and 1–2 dimmed "lip" layers peeking below to imply a deck.
//   - expanded: an inline accordion listing every remaining step, each checkable.
// Checking a step routes through the parent's status toggle; because the parent
// derives `steps` from the live inbox (archived excluded), the next step surfaces
// automatically — auto-advance falls out of the derivation. When the last step is
// checked the group empties and the stack clears from the Inbox.
//
// Motion is timing-only (§7.3 "stone doesn't bounce"): the expand reveal fades +
// rises with motion.standard (250ms ease), honoring Reduce Motion.

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { MotiView } from 'moti';
import { Easing } from 'react-native-reanimated';
// NOT reanimated's useReducedMotion: that is an app-start snapshot which, by
// its own docstring, does not re-render on a live toggle in Settings. This
// file used it and so kept sliding for a user who enabled Reduce Motion
// without relaunching. The repo hook subscribes to reduceMotionChanged and
// re-reads on foreground.
import { useEntranceFrom } from '@/hooks/use-entrance-motion';
import tokens from '../../src/theme/tokens';
import { ambientGlow } from '../../src/theme/glow';
import { haptic } from '../../src/utils/haptics';
import type { InboxRow } from '../../src/features/inbox/group-inbox-rows';
import type { InboxTask } from '../../src/state/app-state';

type GroupRow = Extract<InboxRow, { kind: 'group' }>;

interface Props {
  row: GroupRow;
  expanded: boolean;
  onToggleExpand: (groupId: string) => void;
  onCompleteStep: (step: InboxTask) => void;
  /** Archive every remaining incomplete step at once (the "finish all" escape hatch). */
  onCompleteAll: (steps: InboxTask[]) => void;
  drag: () => void;
  isActive: boolean;
}

// motion.standard as a reanimated easing (tokens.motion stores the CSS string form).
const STANDARD_EASING = Easing.bezier(0.2, 0, 0, 1);

function StepRow({ step, onComplete }: { step: InboxTask; onComplete: (s: InboxTask) => void }) {
  return (
    <View style={styles.stepRow}>
      <Pressable
        onPress={() => onComplete(step)}
        style={styles.checkBtn}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={`Complete ${step.title || 'this step'}`}
      >
        <Text style={styles.checkText} accessibilityElementsHidden importantForAccessibility="no">
          ✓
        </Text>
      </Pressable>
      <Text style={styles.stepTitle} numberOfLines={3}>
        {step.title}
      </Text>
    </View>
  );
}

export default function BreakdownStack({
  row,
  expanded,
  onToggleExpand,
  onCompleteStep,
  onCompleteAll,
  drag,
  isActive,
}: Props) {
  const entranceFrom = useEntranceFrom(-4);
  const { groupId, goalTitle, steps, doneCount, totalCount } = row;

  // Guard: the parent only renders this for group rows (steps.length >= 1), but
  // stay defensive so an empty group never throws mid-render.
  if (steps.length === 0) return null;

  const topStep = steps[0];
  const restSteps = steps.slice(1);
  const showPeeks = !expanded && steps.length > 1;

  const a11yLabel =
    `${goalTitle || 'Steps'}, ${doneCount} of ${totalCount} steps done, ` +
    (expanded ? 'expanded' : 'collapsed');

  return (
    <View
      style={[
        styles.wrap,
        { marginBottom: showPeeks ? 24 : tokens.spacing.sm },
        isActive && styles.wrapActive,
      ]}
    >
      {/* Dimmed lip layers peeking below the card imply a deck (collapsed only). */}
      {showPeeks && steps.length > 2 && <View style={[styles.peek, styles.peek2]} />}
      {showPeeks && <View style={[styles.peek, styles.peek1]} />}

      <View style={styles.card}>
        <View style={styles.header}>
          <Pressable
            style={styles.headerMain}
            onPress={() => {
              haptic('buttonSecondary');
              onToggleExpand(groupId);
            }}
            accessibilityRole="button"
            accessibilityLabel={a11yLabel}
            accessibilityHint="Double tap to expand or collapse the steps"
          >
            {!!goalTitle && (
              <Text style={styles.goalLabel} numberOfLines={2}>
                {goalTitle}
              </Text>
            )}
            <View style={styles.progressRow}>
              <Text style={styles.progress}>
                {doneCount}/{totalCount}
              </Text>
              <Text style={styles.chevron} accessibilityElementsHidden importantForAccessibility="no">
                {expanded ? '▾' : '▸'}
              </Text>
            </View>
          </Pressable>
          <Pressable
            onLongPress={drag}
            delayLongPress={150}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Reorder ${goalTitle || 'steps'}`}
            accessibilityHint="Double tap and hold, then drag to reorder"
          >
            <Text style={styles.dragHandle} accessibilityElementsHidden importantForAccessibility="no">
              ≡
            </Text>
          </Pressable>
        </View>

        {/* Current step is always shown (keyed by id so a completed step's row is
            replaced by the next, not re-animated). */}
        <StepRow key={topStep.id} step={topStep} onComplete={onCompleteStep} />

        {/* Remaining steps reveal on expand, fading + rising as one block. */}
        {expanded && restSteps.length > 0 && (
          <MotiView
            from={entranceFrom}
            animate={{ opacity: 1, translateY: 0 }}
            transition={{ type: 'timing', duration: 250, easing: STANDARD_EASING }}
          >
            {restSteps.map((step) => (
              <StepRow key={step.id} step={step} onComplete={onCompleteStep} />
            ))}
            {/* Finish-all escape hatch: archive every remaining step at once.
                Undoable from the Archived tab. Teal = the sacred completion action. */}
            <Pressable
              style={styles.completeAll}
              onPress={() => {
                haptic('habitResolve');
                onCompleteAll(steps);
              }}
              accessibilityRole="button"
              accessibilityLabel={`Complete all ${steps.length} steps${goalTitle ? ` of ${goalTitle}` : ''}`}
            >
              <Text style={styles.completeAllText}>✓ COMPLETE ALL</Text>
            </Pressable>
          </MotiView>
        )}
      </View>
    </View>
  );
}

const MONO = tokens.font.plexMonoRegular;

const styles = StyleSheet.create({
  wrap: { position: 'relative' },
  wrapActive: { opacity: 0.85 },
  card: {
    backgroundColor: tokens.color.surface,
    borderRadius: 16,
    padding: 18,
    borderWidth: 1,
    borderColor: tokens.color.luminousEdge,
    ...ambientGlow,
  },
  // Lip layers peeking below the card. Inset + offset down; the card (drawn on
  // top) covers all but the bottom sliver, so no see-through through the body.
  peek: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 22,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: tokens.color.luminousEdge,
    backgroundColor: tokens.color.surfaceElevated,
  },
  peek1: { bottom: -8, marginHorizontal: 10, opacity: 0.85, zIndex: -1 },
  peek2: { bottom: -15, marginHorizontal: 20, opacity: 0.6, zIndex: -2 },
  header: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: tokens.spacing.xs },
  headerMain: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  // label.tracked.lg (§5.1): 13pt, +0.16em (~2.1px), 600, uppercase, textMuted.
  goalLabel: {
    flex: 1,
    color: tokens.color.textMuted,
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 2,
    textTransform: 'uppercase',
    marginRight: tokens.spacing.sm,
  },
  progressRow: { flexDirection: 'row', alignItems: 'center' },
  // numeric.sm (§5.1): Plex Mono 13pt, tabular.
  progress: {
    color: tokens.color.textMuted,
    fontSize: 13,
    fontFamily: MONO,
    fontVariant: ['tabular-nums'],
  },
  chevron: { color: tokens.color.textMuted, fontSize: 13, marginLeft: 6 },
  dragHandle: { color: tokens.color.textDisabled, fontSize: 20, fontWeight: '700', paddingLeft: tokens.spacing.sm },
  stepRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: tokens.spacing.sm },
  // Matches the inbox row checkmark (goldWash fill, gold border/tick).
  checkBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: tokens.color.goldWash,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: tokens.color.gold,
  },
  checkText: { color: tokens.color.gold, fontSize: 13, fontWeight: '900' },
  stepTitle: { flex: 1, color: tokens.color.text, fontSize: 16, lineHeight: 22, marginLeft: 12 },
  // Finish-all action: a quiet tracked-caps row under the steps, divided by a
  // hairline. Teal reads as the completion (sacred-active) action; button.tracked.
  completeAll: {
    marginTop: tokens.spacing.xs,
    paddingTop: tokens.spacing.sm,
    borderTopWidth: 1,
    borderTopColor: tokens.color.goldHairline,
    alignItems: 'center',
  },
  completeAllText: { color: tokens.color.teal, fontSize: 13, fontWeight: '600', letterSpacing: 1.8 },
});
