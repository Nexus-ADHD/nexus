/**
 * Phase 5 — first-connect triage flow modal.
 *
 * Renders as a full-screen overlay above the tab navigator when
 * useTriageStore.isActive === true. Three sub-views:
 *   1. Intro    — shown before the first card.
 *   2. Card     — one reminder at a time with four action buttons.
 *   3. Done     — closing screen after the last decision.
 *
 * The component owns no business logic beyond display state. Each
 * action calls applyTriageDecision (pure), patches the local
 * InboxTask, optionally pushes a due-date update to EventKit, then
 * advances the store. Apple Reminders writes are best-effort: if
 * EventKit fails, the local patch still applies so the user's
 * decision sticks; a console.warn surfaces the failure.
 *
 * Visual language follows the existing app conventions (cosmic
 * StarField backdrop, gold accent tokens.color.gold, uppercase tracked labels). Treat the
 * spacing and animation timing as a first pass — the polish pass
 * is the user's, on device.
 */
// @ts-nocheck
import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Modal,
  Alert,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MotiView } from 'moti';
import { StarField } from '../../components/ui/StarField';
import tokens from '../../theme/tokens';
import { haptic } from '../../utils/haptics';
import { PrimaryPill } from '../../components/ui/PrimaryPill';
import { useTriageStore } from '../../state/triage-store';
import { useAppState } from '../../state/app-state';
import { useEntranceFrom } from '@/hooks/use-entrance-motion';
import {
  applyTriageDecision,
  type TriageDecision,
} from '../../state/triage-decisions';
import { updateReminderDueDate } from '../../services/apple-reminders';

// Note: 111 close to surface (111113, delta 1 digit, established precedent)
const SURFACE = tokens.color.surface;
// FIXME(nex-56): 1E1E1E neutral border, no token — design review (CLAUDE.md §6.2 wants gold hairline; surfaceElevated is semantically a fill, not a border)
const BORDER = tokens.color.goldHairline;
const GOLD = tokens.color.gold;
const TEXT = tokens.color.text;
// FIXME(nex-56): 777 off-scale gray (intro/source/progress label), no token — design review
const MUTED = tokens.color.textMuted;
// FIXME(nex-56): 555 off-scale gray (skip button text), no token — design review
const DIM = tokens.color.textMuted;

interface TriageItemView {
  id: string;
  title: string;
  source?: string;
  externalId?: string;
}

function buildItemView(
  itemId: string,
  inbox: any[],
): TriageItemView | null {
  const item = inbox.find((t) => t.id === itemId);
  if (!item) return null;
  return {
    id: item.id,
    title: item.title || '',
    source: item.source,
    externalId: item.externalId,
  };
}

export function TriageFlow() {
  const isActive = useTriageStore((s) => s.isActive);
  const currentBatch = useTriageStore((s) => s.currentBatch);
  const currentIndex = useTriageStore((s) => s.currentIndex);
  const recordDecision = useTriageStore((s) => s.recordDecision);
  const advance = useTriageStore((s) => s.advance);
  const complete = useTriageStore((s) => s.complete);
  const dismiss = useTriageStore((s) => s.dismiss);

  // We pull these via getState() at action time rather than
  // subscribing — this component re-renders once per advance(), and
  // the store reads happen inside event handlers.
  const [stage, setStage] = useState<'intro' | 'card' | 'done'>(
    currentIndex === 0 ? 'intro' : 'card',
  );
  const [working, setWorking] = useState(false);

  const total = currentBatch.length;
  const remaining = Math.max(0, total - currentIndex);
  const isLastCard = currentIndex >= total - 1;

  const currentItemId = currentBatch[currentIndex] ?? null;
  const view: TriageItemView | null = useMemo(() => {
    if (!currentItemId) return null;
    const inbox = (useAppState as any).getState().inbox as any[];
    return buildItemView(currentItemId, inbox);
  }, [currentItemId]);

  const handleDecision = useCallback(
    async (decision: TriageDecision) => {
      if (!currentItemId || working) return;
      const today = new Date();
      const inbox = (useAppState as any).getState().inbox as any[];
      const item = inbox.find((t) => t.id === currentItemId);
      if (!item) {
        // Item vanished mid-flight (e.g. external delete). Just
        // advance past it.
        advance();
        return;
      }
      let patch;
      try {
        patch = applyTriageDecision(
          { id: item.id, source: item.source, externalId: item.externalId, dueDate: item.dueDate },
          decision,
          today,
        );
      } catch (e) {
        // applyTriageDecision throws on manual items. Skip rather
        // than block the user.
        // eslint-disable-next-line no-console
        console.warn('[triage] applyTriageDecision threw:', (e as Error)?.message ?? e);
        advance();
        return;
      }
      setWorking(true);
      try {
        // 1. Apply the local patch via app-state.
        const updateInboxTask = (useAppState as any).getState().updateInboxTask;
        if (typeof updateInboxTask === 'function' && Object.keys(patch.local).length > 0) {
          updateInboxTask(currentItemId, patch.local as any);
        }
        // 2. Push remote update if requested. Best-effort: failure
        //    here doesn't block the user's decision from sticking.
        if (patch.remoteUpdate && item.externalId) {
          try {
            await updateReminderDueDate(item.externalId, patch.remoteUpdate.dueDate);
          } catch (e) {
            // eslint-disable-next-line no-console
            console.warn('[triage] EventKit due-date update failed:', (e as Error)?.message ?? e);
          }
        }
        // 3. Record + advance.
        recordDecision(currentItemId, decision);
        if (isLastCard) {
          setStage('done');
        } else {
          advance();
        }
      } finally {
        setWorking(false);
      }
    },
    [currentItemId, working, advance, recordDecision, isLastCard],
  );

  const handleSkipRemaining = useCallback(() => {
    if (remaining <= 0) return;
    Alert.alert(
      `Skip the remaining ${remaining}?`,
      "They'll stay in Apple Reminders.",
      [
        { text: 'Keep going', style: 'cancel' },
        {
          text: 'Skip them',
          style: 'destructive',
          onPress: () => {
            haptic('voiceAmbiguous');
            dismiss();
          },
        },
      ],
    );
  }, [remaining, dismiss]);

  const handleBegin = useCallback(() => {
    setStage('card');
  }, []);

  const handleContinue = useCallback(() => {
    complete();
  }, [complete]);

  if (!isActive) return null;

  return (
    <Modal
      visible={isActive}
      animationType="fade"
      presentationStyle="fullScreen"
      onRequestClose={() => {
        // iOS may fire onRequestClose during modal presentation
        // lifecycle events, not just user intent. Only treat it as
        // skip-remaining if we're actively on a card with items
        // still to triage. Without this guard, a presentation-time
        // fire could dismiss the modal before the user sees their
        // first card. (Android hardware-back still routes through
        // here when stage === 'card' AND remaining > 0.)
        if (stage !== 'card' || remaining === 0) return;
        handleSkipRemaining();
      }}
    >
      {/* Native fullScreen Modals render above the global StarField
          (app/_layout.tsx), so the triage flow mounts its own cosmic
          backdrop for the transparent content to sit on — same
          pattern as the dev showcase modals (#97). */}
      <View style={styles.cosmicWrapper}>
        <StarField />
        <View style={StyleSheet.absoluteFill}>
          {/* SafeAreaView respects the iPhone notch + home-indicator
              insets so the card and action buttons aren't clipped by
              system UI on tall phones. */}
          <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
            {stage === 'intro' && <IntroView onBegin={handleBegin} total={total} />}

            {stage === 'card' && view && (
              <CardView
                view={view}
                index={currentIndex}
                total={total}
                working={working}
                onDecision={handleDecision}
                onSkipRemaining={handleSkipRemaining}
                remaining={remaining}
              />
            )}

            {stage === 'card' && !view && (
              <View style={styles.center}>
                <ActivityIndicator color={GOLD} />
              </View>
            )}

            {stage === 'done' && <DoneView onContinue={handleContinue} />}
          </SafeAreaView>
        </View>
      </View>
    </Modal>
  );
}

function IntroView({ onBegin, total }: { onBegin: () => void; total: number }) {
  const entranceFrom = useEntranceFrom(8);
  return (
    <MotiView
      from={entranceFrom}
      animate={{ opacity: 1, translateY: 0 }}
      transition={{ type: 'timing', duration: 350 }}
      style={styles.center}
    >
      <Text style={styles.eyebrow}>{total} TO TRIAGE</Text>
      <Text style={styles.introLine}>
        Apple Reminders is where things go to get forgotten.
      </Text>
      <Text style={styles.introLineSecond}>
        One at a time.
      </Text>
      <PrimaryPill onPress={onBegin}>
        BEGIN
      </PrimaryPill>
    </MotiView>
  );
}

function CardView({
  view,
  index,
  total,
  working,
  onDecision,
  onSkipRemaining,
  remaining,
}: {
  view: TriageItemView;
  index: number;
  total: number;
  working: boolean;
  onDecision: (d: TriageDecision) => void;
  onSkipRemaining: () => void;
  remaining: number;
}) {
  return (
    <View style={styles.cardWrap}>
      {/* Progress dots */}
      <View style={styles.progressRow}>
        <View style={styles.dotsRow}>
          {Array.from({ length: total }).map((_, i) => (
            <View
              key={i}
              style={[
                styles.dot,
                i < index && styles.dotDone,
                i === index && styles.dotActive,
              ]}
            />
          ))}
        </View>
        <Text style={styles.progressLabel}>
          {index + 1} OF {total}
        </Text>
      </View>

      {/* Card */}
      <MotiView
        key={view.id}
        from={{ opacity: 0, translateX: 24 }}
        animate={{ opacity: 1, translateX: 0 }}
        transition={{ type: 'timing', duration: 220 }}
        style={styles.card}
      >
        {/* ScrollView so a very long reminder title can scroll
            inside the card rather than pushing the action buttons
            off-screen. flexGrow:1 + center justification keeps
            short titles vertically centered like before. */}
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.cardTitle} numberOfLines={6}>
            {view.title}
          </Text>
          {/* Source line matches the Inbox card source badge — no list
              name. List names aren't reliable here (InboxTask doesn't
              carry listId) and don't help triage decisions anyway. */}
          <Text style={styles.cardSource}>↳ Apple Reminders</Text>
        </ScrollView>
      </MotiView>

      {/* Actions */}
      <View style={styles.actions}>
        <PrimaryPill
          fullWidth
          onPress={() => onDecision('today')}
          disabled={working}
        >
          TODAY
        </PrimaryPill>
        <Pressable
          style={[styles.btnWeek, working && styles.btnDisabled]}
          onPress={() => { haptic('dragDrop'); onDecision('this_week'); }}
          disabled={working}
        >
          <Text style={styles.btnWeekText}>THIS WEEK</Text>
        </Pressable>
        <Pressable
          style={[styles.btnLater, working && styles.btnDisabled]}
          onPress={() => { haptic('dragDrop'); onDecision('later'); }}
          disabled={working}
        >
          <Text style={styles.btnLaterText}>LATER</Text>
        </Pressable>
        <Pressable
          style={[styles.btnSkip, working && styles.btnDisabled]}
          onPress={() => { haptic('dragDrop'); onDecision('skip'); }}
          disabled={working}
        >
          <Text style={styles.btnSkipText}>Skip</Text>
        </Pressable>
      </View>

      {/* Skip remaining */}
      {remaining > 1 && (
        <Pressable style={styles.skipAll} onPress={onSkipRemaining}>
          <Text style={styles.skipAllText}>Skip remaining ({remaining})</Text>
        </Pressable>
      )}
    </View>
  );
}

function DoneView({ onContinue }: { onContinue: () => void }) {
  const entranceFrom = useEntranceFrom(8);
  return (
    <MotiView
      from={entranceFrom}
      animate={{ opacity: 1, translateY: 0 }}
      transition={{ type: 'timing', duration: 400 }}
      style={styles.center}
    >
      <Text style={styles.doneLine}>Your inbox is shaped.</Text>
      <PrimaryPill onPress={onContinue}>
        CONTINUE
      </PrimaryPill>
    </MotiView>
  );
}

const styles = StyleSheet.create({
  // Void fallback fills any gap before the StarField photo paints.
  cosmicWrapper: { flex: 1, backgroundColor: tokens.color.void },
  // Transparent so the modal-local StarField above shows through.
  container: { flex: 1, backgroundColor: 'transparent' },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: tokens.spacing.xl,
  },

  // Intro / Done
  eyebrow: {
    color: GOLD,
    // FIXME(nex-56): off-scale fontSize 11, design review
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 4,
    marginBottom: tokens.spacing.xl,
  },
  introLine: {
    color: TEXT,
    // FIXME(nex-56): fontSize 22 matches titleSection/poeticMd size but Fraunces italic + fontWeight default '400' diverges from poeticMd '300' — design review
    fontSize: 22,
    lineHeight: 30,
    textAlign: 'center',
    fontStyle: 'italic',
    marginBottom: tokens.spacing.md,
    fontFamily: tokens.font.fraunces,
  },
  introLineSecond: {
    color: MUTED,
    // FIXME(nex-56): fontSize 17 matches bodyLg size but Fraunces italic family + lineHeight 24 ≠ token 26 — design review
    fontSize: 17,
    lineHeight: 24,
    textAlign: 'center',
    fontStyle: 'italic',
    marginBottom: 56 /* FIXME(nex-56): off-scale spacing 56 — review */,
    fontFamily: tokens.font.fraunces,
  },
  doneLine: {
    color: TEXT,
    // FIXME(nex-56): off-scale fontSize 26 (Fraunces italic display), design review
    fontSize: 26,
    lineHeight: 34,
    textAlign: 'center',
    fontStyle: 'italic',
    // Was 8 when paired with the now-removed "Welcome." sub-line.
    // With the sub-line gone, restore breathing room before the
    // Continue button so the screen doesn't feel cramped.
    marginBottom: 56 /* FIXME(nex-56): off-scale spacing 56 — review */,
    fontFamily: tokens.font.fraunces,
  },
  doneSub: {
    color: GOLD,
    // FIXME(nex-56): off-scale fontSize 18, design review
    fontSize: 18,
    lineHeight: 24,
    textAlign: 'center',
    fontStyle: 'italic',
    marginBottom: 56 /* FIXME(nex-56): off-scale spacing 56 — review */,
    fontFamily: tokens.font.fraunces,
  },

  // Card view
  cardWrap: {
    flex: 1,
    paddingHorizontal: tokens.spacing.lg,
    // SafeAreaView handles the top inset; we just need a comfortable
    // gap between the system UI and the progress dots.
    paddingTop: tokens.spacing.xl,
    paddingBottom: tokens.spacing.lg,
  },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: tokens.spacing.xl,
  },
  dotsRow: { flexDirection: 'row', gap: 6 /* FIXME(nex-56): off-scale spacing 6 — review */ },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: BORDER,
  },
  dotDone: { backgroundColor: GOLD, opacity: 0.5 },
  dotActive: { backgroundColor: GOLD, width: 16 },
  progressLabel: {
    color: MUTED,
    // FIXME(nex-56): off-scale fontSize 10, design review
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 2,
  },

  card: {
    flex: 1,
    backgroundColor: SURFACE,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: BORDER,
    paddingHorizontal: tokens.spacing.lg,
    paddingVertical: tokens.spacing.lg,
    justifyContent: 'center',
    marginBottom: 20 /* FIXME(nex-56): off-scale spacing 20 — review */,
    // Ensures the card has visual presence on small screens even
    // when the title is short (otherwise flex:1 against tall action
    // stacks could squash the card to a thin band).
    minHeight: 140,
  },
  cardTitle: {
    color: TEXT,
    // FIXME(nex-56): off-scale fontSize 26 (Fraunces italic display), design review
    fontSize: 26,
    lineHeight: 34,
    fontStyle: 'italic',
    fontFamily: tokens.font.fraunces,
    marginBottom: 18 /* FIXME(nex-56): off-scale spacing 18 — review */,
  },
  cardSource: {
    color: MUTED,
    // FIXME(nex-56): off-scale fontSize 11, design review
    fontSize: 11,
    fontFamily: tokens.font.plexMonoRegular,
  },

  // Actions
  actions: { gap: 10 /* FIXME(nex-56): off-scale spacing 10 — review */ },
  btnWeek: {
    backgroundColor: 'transparent',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: GOLD,
    paddingVertical: tokens.spacing.md,
    alignItems: 'center',
  },
  btnWeekText: {
    color: GOLD,
    // FIXME(nex-56): fontSize 13 matches labelTrackedLg size but fontWeight '900' ≠ token '600' — design review
    fontSize: 13,
    fontWeight: '900',
    letterSpacing: 3,
  },
  btnLater: {
    backgroundColor: SURFACE,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: BORDER,
    paddingVertical: tokens.spacing.md,
    alignItems: 'center',
  },
  btnLaterText: {
    color: TEXT,
    // FIXME(nex-56): fontSize 13 matches labelTrackedLg size but fontWeight '900' ≠ token '600' — design review
    fontSize: 13,
    fontWeight: '900',
    letterSpacing: 3,
  },
  btnSkip: {
    paddingVertical: tokens.spacing.sm,
    alignItems: 'center',
  },
  btnSkipText: {
    color: DIM,
    // FIXME(nex-56): fontSize 13 matches caption size but fontWeight '500' (token match) + no fontFamily set — design review
    fontSize: 13,
    fontWeight: '500',
    letterSpacing: 1,
  },
  btnDisabled: { opacity: 0.4 },

  // Footer skip-all link
  skipAll: { paddingVertical: tokens.spacing.sm, alignItems: 'center', marginTop: tokens.spacing.xxs },
  // FIXME(nex-56): off-scale fontSize 12, design review
  skipAllText: { color: MUTED, fontSize: 12, letterSpacing: 1 },
});
