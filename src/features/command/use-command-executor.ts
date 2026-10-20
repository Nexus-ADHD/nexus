/**
 * use-command-executor.ts — the one execution controller for a tier-resolved
 * ProposedAction[] (Command tab today, the coach thread next).
 *
 * Extracted from app/(tabs)/index.tsx (docs/typescript-hardening.md rule #3:
 * the command execution logic had to leave that @ts-nocheck screen before it
 * can be hardened). Behaviour is unchanged; every comment that explains a
 * guard travelled with the code it guards. What lives here:
 *
 *   - executeActions: the re-entrancy lock + 3s same-proposal dedupe, the
 *     app-state bag handed to executeProposedActions, Apple Calendar /
 *     Reminders callbacks, north-star `item_captured` analytics, the ledger,
 *     and the Home capture echo (NEX-196).
 *   - the ledger handlers: jump, undo (with Apple cleanup), time-block offer
 *     accept/undo (NEX-206), breakdown accept/undo (NEX-210), manual retry
 *     and the silent Apple-sync retry (on a timer and on foreground).
 *   - the Apple Calendar helpers the retry paths share.
 *
 * What stays in the screen: everything about HOW a capture reaches this
 * controller (voice, typed, preview, clarification chip) and the screen's
 * own success chrome (first-run flag, scroll, "Added." flash). Those come in
 * through `onExecuteStart` / `onExecuteSuccess`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState } from 'react-native';
import { useRouter } from 'expo-router';
import * as Calendar from 'expo-calendar';
import { useAppState, type Pillar } from '../../state/app-state';
import { useRemindersStore } from '../../state/reminders-store';
import { clearAppleLink, getAppleLink, hydrateAppleLinks, setAppleLink } from '../../state/apple-link-store';
import { haptic } from '../../utils/haptics';
import { announce } from '../../utils/a11y';
import { getLocalDateKey, type TimeBlock } from '../../utils/recurrence';
import { trackEvent } from '../../services/analytics';
import { recordCapture, recordFirstReach } from '../../services/capture-reach-tracker';
import { extractCaptures } from '../../services/north-star-metrics';
import { breakdownIntoSteps } from '../../services/breakdown-steps';
import type { BreakdownGrain } from './breakdown';
import type { CaptureSurface } from './confirmation-copy';
import type { ProposedAction } from './command-types';
import { buildCalendarRecurrenceRule } from './calendar-recurrence';
import { SCHEDULE_DEFAULTED_NOTE } from './scheduling-default';
import {
  executeProposedActions,
  getProposalExecutionKey,
  type ExecutorAppState,
  type LedgerItem,
} from './command-executor';
import {
  getNextOccurrenceForRecurringAction,
  normalizeDaysOfWeek,
  resolveRecurringActionTime,
  RECURRING_EVENT_DURATION_MINUTES,
} from './recurring-event-time';

/** Where the capture was initiated; emitted as `capture_origin` (NEX-200). */
export type CaptureOrigin = 'command' | 'coach';

export interface UseCommandExecutorOptions {
  captureOrigin: CaptureOrigin;
  /**
   * Called synchronously once the lock is taken and the previous ledger is
   * cleared, before any write. The Command screen drops its clarification and
   * low-tier cards here so the screen never shows two primary actions.
   */
  onExecuteStart?: () => void;
  /** Called after a run where no row failed or was partial. */
  onExecuteSuccess?: (ledger: LedgerItem[]) => void;
}

export interface CommandExecutorController {
  executionLedger: LedgerItem[] | null;
  isExecuting: boolean;
  retryingLedgerKeys: string[];
  breakdownGrain: BreakdownGrain;
  /**
   * Execute a tier-resolved action list. Resolves false when nothing ran
   * (empty list, re-entry, or the 3s same-proposal dedupe) so a caller that
   * records "applying" beforehand can undo that record; true once the run
   * completed (successfully or with a ledger of failures).
   */
  executeActions: (actions: ProposedAction[]) => Promise<boolean>;
  dismissLedger: () => void;
  /** Ledger callbacks, named to match CommandExecutionLedgerProps. */
  onRetryItem: (item: LedgerItem, index: number) => Promise<void>;
  onUndoItem: (item: LedgerItem) => Promise<void>;
  onJumpItem: (item: LedgerItem) => void;
  onAcceptTimeBlock: (item: LedgerItem, block: TimeBlock) => Promise<boolean>;
  onUndoTimeBlock: (item: LedgerItem) => Promise<void>;
  onAcceptBreakdown: (item: LedgerItem, grain: BreakdownGrain) => Promise<{ steps: string[]; ids: string[] }>;
  onUndoBreakdown: (item: LedgerItem, stepIds: string[]) => void;
  /** Apple Calendar helpers shared with retry paths and with any screen-side sync. */
  ensureWritableCalendar: () => Promise<string>;
  createRecurringAppleCalendarEvent: (
    calendarId: string,
    action: ProposedAction,
    orbitRuleId: string,
  ) => Promise<string>;
  attachAppleEventToRecurringRule: (ruleId: string, appleEventId: string) => void;
}

const CALENDAR_DAY_MAP: Record<number, number> = {
  0: Calendar.DayOfTheWeek.Sunday,
  1: Calendar.DayOfTheWeek.Monday,
  2: Calendar.DayOfTheWeek.Tuesday,
  3: Calendar.DayOfTheWeek.Wednesday,
  4: Calendar.DayOfTheWeek.Thursday,
  5: Calendar.DayOfTheWeek.Friday,
  6: Calendar.DayOfTheWeek.Saturday,
};

// NEX-195: surface → destination tab. A captured item is already surfaced
// there (NEX-194 save-and-surface); JUMP just takes the user to it. Apple
// calendar_add events round-trip into Orbit's Today's Horizon.
const SURFACE_ROUTE: Record<string, string> = {
  home_today: '/(tabs)/home',
  inbox: '/(tabs)/inbox',
  orbit: '/(tabs)/orbit',
  align: '/(tabs)/align',
  calendar: '/(tabs)/orbit',
};

const recurringRuleExists = (ruleId: string): boolean => {
  const rules = useAppState.getState().recurringRules;
  return (Array.isArray(rules) ? rules : []).some((r) => r?.id === ruleId);
};

// Greptile P (TOCTOU): the rule can be UNDONE while createRecurringAppleCalendarEvent
// is in flight (the await). A pre-create existence check passes, the rule is then
// deleted, and the returned event id would attach to a dead rule — orphaning the
// Apple series. After the create returns, re-check; if the rule is gone, delete the
// just-created event and tell the caller to abort the attach. Returns true = handled
// (caller must not attach), false = rule still present (proceed normally).
// The one place that deletes by a raw appleEventId rather than this device's
// stored link — and it is safe BY CONSTRUCTION: the caller passes the id that
// createRecurringAppleCalendarEvent just returned, on this device, in the
// same call. It is never the rule's shared mirror, so it cannot be another
// device's identifier. Do not "fix" this to read getAppleLink(): no link has
// been stored yet at this point, which is precisely why the event is an
// orphan needing cleanup.
const discardAppleEventIfRuleGone = (
  ruleId: string,
  appleEventId: string | null | undefined,
): boolean => {
  if (recurringRuleExists(ruleId)) return false;
  if (appleEventId) {
    void Calendar.deleteEventAsync(String(appleEventId), { futureEvents: true }).catch(() => {});
  }
  return true;
};

const createRecurringAppleCalendarEvent = async (
  calendarId: string,
  action: ProposedAction,
  orbitRuleId: string,
): Promise<string> => {
  const resolvedTime = resolveRecurringActionTime(action);
  if (!resolvedTime) {
    throw new Error('Recurring calendar blocks need an exact time or time block to sync to Apple Calendar.');
  }
  const selectedDays =
    Array.isArray(action.daysOfWeek) && action.daysOfWeek.length
      ? normalizeDaysOfWeek(action.daysOfWeek)
      : [new Date().getDay()];
  const startDate = getNextOccurrenceForRecurringAction(selectedDays, resolvedTime);
  const endDate = new Date(startDate.getTime() + RECURRING_EVENT_DURATION_MINUTES * 60 * 1000);
  const daysOfTheWeek = selectedDays.map((day) => ({
    dayOfTheWeek: CALENDAR_DAY_MAP[day],
  }));
  const syncTag = `[ORBIT_RULE_ID:${orbitRuleId}]`;
  const noteParts = [action.description?.trim(), syncTag].filter(Boolean);
  const eventId = await Calendar.createEventAsync(calendarId, {
    title: action.title,
    notes: noteParts.join('\n\n'),
    startDate,
    endDate,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    recurrenceRule: {
      frequency: Calendar.Frequency.WEEKLY,
      interval: 1,
      daysOfTheWeek,
    },
  });
  return eventId;
};

const ensureWritableCalendar = async (): Promise<string> => {
  let permission = await Calendar.getCalendarPermissionsAsync();
  if (permission.status !== 'granted') {
    permission = await Calendar.requestCalendarPermissionsAsync();
  }
  if (permission.status !== 'granted') {
    throw new Error('Calendar access is required to add calendar events.');
  }
  const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
  const writable = calendars.filter((c) => c.allowsModifications);
  if (writable.length === 0) {
    throw new Error('Could not find a writable Apple Calendar.');
  }
  return writable[0].id;
};

const attachAppleEventToRecurringRule = (ruleId: string, appleEventId: string): void => {
  // The event was just created on THIS device, so record the link locally —
  // that is what later lets the Orbit reconcile distinguish "the user deleted
  // this event" from "this id was never mine". The store write is async and
  // best-effort; if it is lost, the reconcile simply sees no link and does
  // nothing, then re-links on a later pass. Never a destructive outcome.
  void setAppleLink(ruleId, appleEventId).catch(() => {});
  const liveState = useAppState.getState();
  if (typeof liveState.linkRecurringRuleToAppleEvent === 'function') {
    liveState.linkRecurringRuleToAppleEvent(ruleId, appleEventId);
    return;
  }
  useAppState.setState((state) => ({
    recurringRules: (Array.isArray(state.recurringRules) ? state.recurringRules : []).map((rule) =>
      rule?.id === ruleId ? { ...rule, appleEventId } : rule,
    ),
  }));
};

const createCalendarEventCb = async (calendarId: string, action: ProposedAction): Promise<void> => {
  // A recurring calendar_add carries a nested `recurrence` object → a real
  // repeating Apple Calendar event. One-off (no recurrence) is byte-identical
  // to before. The helper is pure (no expo-calendar import) so it's vitest-
  // testable; cast its plain shape to the enum-typed rule at this boundary.
  // Pass the SAME `action.startISO` that feeds `startDate` below so a weekly
  // rule's repeat day is anchored to the start date's weekday — the first
  // occurrence and every repeat can't diverge. (Note: unlike
  // createRecurringAppleCalendarEvent, which derives the start from the day
  // list, this path anchors the day list to the start.)
  const recurrenceRule = buildCalendarRecurrenceRule(action, action.startISO!) as
    | Calendar.RecurrenceRule
    | undefined;
  await Calendar.createEventAsync(calendarId, {
    title: action.title,
    startDate: new Date(action.startISO!),
    endDate: new Date(action.endISO!),
    // Anchor recurrence to the device timezone so repeats land at the local
    // time (same device-timezone policy as createRecurringAppleCalendarEvent).
    ...(recurrenceRule
      ? { recurrenceRule, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }
      : {}),
  });
};

const isPendingAppleSync = (item: LedgerItem | null | undefined, retryingKeys: string[], attempts: Record<string, number>) =>
  !!item &&
  (item.status === 'partial' || item.status === 'failed') &&
  item.retryType === 'recurring_apple_sync' &&
  !!item.recurringRuleId &&
  !!item.actionPayload &&
  !retryingKeys.includes(item.key) &&
  (attempts[item.key] ?? 0) < 1;

export function useCommandExecutor(options: UseCommandExecutorOptions): CommandExecutorController {
  const { captureOrigin, onExecuteStart, onExecuteSuccess } = options;
  const router = useRouter();
  // NEX-210: remembered breakdown grain — primary chip on the "break into steps" offer.
  const breakdownGrain = useAppState((s) => s.breakdownGrain);

  const [executionLedger, setExecutionLedger] = useState<LedgerItem[] | null>(null);
  const [retryingLedgerKeys, setRetryingLedgerKeys] = useState<string[]>([]);
  const [isExecuting, setIsExecuting] = useState(false);
  const silentAppleSyncRetryInFlightRef = useRef(false);
  const silentAppleSyncRetryAttemptsRef = useRef<Record<string, number>>({});
  const executionLockRef = useRef(false);
  // Synchronous dedupe of the same parsed capture. A duplicated final-transcript
  // event (two stop deliveries milliseconds apart) must not double-write; a
  // DELIBERATE repeat of the same command seconds later must still go through.
  // State can't gate this (its update isn't visible within the same call stack),
  // so we key on a ref with a short time window.
  const lastExecRef = useRef<{ key: string; at: number } | null>(null);
  // The callbacks are read through refs so the controller's own callbacks stay
  // stable across renders and never close over a stale screen handler.
  const onExecuteStartRef = useRef(onExecuteStart);
  const onExecuteSuccessRef = useRef(onExecuteSuccess);
  onExecuteStartRef.current = onExecuteStart;
  onExecuteSuccessRef.current = onExecuteSuccess;

  const clearRetryOnLedger = useCallback((key: string) => {
    setExecutionLedger((prev) =>
      Array.isArray(prev)
        ? prev.map((entry) => (entry?.key === key ? { ...entry, retryType: undefined } : entry))
        : prev,
    );
  }, []);

  const onJumpItem = useCallback(
    (item: LedgerItem) => {
      const route = item.surface ? SURFACE_ROUTE[item.surface] : undefined;
      if (!route) return;
      haptic('buttonPrimary');
      // NEX-215 (L-4): the JUMP is a SURFACED first-reach (confirmation_jump). Record
      // before we navigate so it marks the capture ahead of any manual interaction.
      // capture_id is the opaque entity id; calendar rows carry no entityId and are
      // skipped. age_bucket is derived from the inbox entity's createdAt when this is
      // a one-off (the common case); other surfaces omit it. NEX-261: routed through
      // the tracker so it emits at most once per capture, true-first.
      if (item.entityId && item.surface) {
        const inbox = useAppState.getState().inbox;
        const inboxEntity =
          item.surface === 'inbox' && Array.isArray(inbox)
            ? inbox.find((t) => t?.id === item.entityId)
            : undefined;
        const createdAt: unknown = inboxEntity?.createdAt;
        void recordFirstReach(item.entityId, {
          surface: item.surface as CaptureSurface,
          accessMethod: 'confirmation_jump',
          capturedAtMs: typeof createdAt === 'number' ? createdAt : undefined,
        });
      }
      setExecutionLedger(null);
      // NEX-189 (Law A): for a home_today item, land ON Today's Habits, not
      // Home-top. Home reads ?focus=habits, scrolls to the section, clears it.
      if (item.surface === 'home_today') {
        router.push({ pathname: route as never, params: { focus: 'habits' } });
      } else {
        router.push(route as never);
      }
    },
    [router],
  );

  // NEX-195: one-tap undo. Removes the Nexus entity the capture created and,
  // best-effort, the synced Apple side effect — reversing OUR OWN create only.
  // Apple ids are read LIVE off the store entity at tap time (the reminder
  // externalId is stamped async, so it isn't reliable at confirmation time).
  // Always best-effort: the local removal is the source of truth and Apple
  // failures are swallowed (never throw into the confirmation UI).
  const onUndoItem = useCallback(
    async (item: LedgerItem) => {
      haptic('buttonSecondary');
      // Undo branches below delete native calendar events. Hydrate first so
      // getAppleLink can see links written in a PREVIOUS session, otherwise we
      // fall back to the shared mirror and risk targeting another device's id.
      await hydrateAppleLinks().catch(() => ({}));
      const state = useAppState.getState();
      const entityId = item.entityId;
      if (!entityId) return;
      try {
        switch (item.type) {
          case 'inbox_add':
          case 'todo_add': {
            const task = (Array.isArray(state.inbox) ? state.inbox : []).find((t) => t?.id === entityId);
            // The mirror stamps externalId async after the capture. Reading it
            // live means an undo BEFORE the mirror resolves can't find the id —
            // the Apple Reminder it created is then a best-effort orphan (a
            // leftover, never a destroyed real event, so no Law E violation).
            const externalId = task?.externalId;
            state.deleteInboxTask?.(entityId);
            if (externalId) {
              void useRemindersStore.getState().deleteMirroredReminder(externalId);
            }
            // NEX-196: if the undone item was the one echoed on Home, drop the
            // echo ref now (the validity gate also hides it, but this avoids a
            // one-frame stale chip).
            if (state.justCaptured?.id === entityId) state.clearJustCaptured?.();
            break;
          }
          case 'recurring_add': {
            // OUR event, not the shared mirror. `appleEventId` on the rule is
            // last-writer-wins across devices, so it can hold an identifier
            // minted elsewhere — deleting by it targets the wrong event (or
            // nothing) and leaves this device's series orphaned.
            const ownEventId = getAppleLink(entityId);
            state.deleteRecurringRule?.(entityId);
            void clearAppleLink(entityId).catch(() => {});
            // Greptile P: the rule may have a PENDING Apple-sync retry (partial
            // status, sync failed). Once the rule is gone, that retry must not
            // fire — it would create an Apple Calendar event for a deleted rule
            // (orphaned external state). Clear the retry metadata on this ledger
            // item so neither the silent retry effect nor the RETRY button picks
            // it up. (The retry creators also guard on rule existence below.)
            clearRetryOnLedger(item.key);
            if (ownEventId) {
              // Remove the whole series WE just created (futureEvents) — never a
              // pre-existing event, and never an id known only from the shared
              // mirror.
              void Calendar.deleteEventAsync(String(ownEventId), { futureEvents: true }).catch(() => {});
            }
            break;
          }
          case 'recurring_todo_add': {
            state.deleteRecurringToDo?.(entityId);
            break;
          }
          case 'align': {
            // Use the store action (prunes goalHabitMap) rather than a raw filter.
            state.deletePillar?.(entityId);
            break;
          }
          default:
            break;
        }
      } catch {
        // Undo is best-effort; never throw into the confirmation UI.
      }
    },
    [clearRetryOnLedger],
  );

  // NEX-206 (Or-3): accept a suggested time block for a bare time-less habit.
  // ATOMIC with Apple Calendar (the offer syncs, per the product decision): we
  // create the recurring event FIRST, then apply the block + link the event in
  // ONE updateRecurringRule patch. If the calendar is denied / no writable
  // calendar / the create fails, NOTHING is applied (return false) — the rule
  // never carries a block without its backing event (which Orbit would otherwise
  // render as a fabricated clock block). Reuses the NEX-194 retry precedent
  // (ensure → create → TOCTOU discard → attach). Returns whether the block stuck.
  const onAcceptTimeBlock = useCallback(async (item: LedgerItem, block: TimeBlock): Promise<boolean> => {
    const ruleId = item.suggestTimeBlock?.ruleId;
    if (!ruleId) return false;
    const state = useAppState.getState();
    const rule = (Array.isArray(state.recurringRules) ? state.recurringRules : []).find((r) => r?.id === ruleId);
    // Rule already gone (e.g. the habit was undone) — nothing to anchor.
    if (!rule) return false;
    try {
      const calendarId = await ensureWritableCalendar();
      const action: ProposedAction = {
        type: 'recurring_add',
        title: rule.title,
        daysOfWeek: Array.isArray(rule.daysOfWeek) ? rule.daysOfWeek : [],
        preferredTimeBlock: block,
      };
      const appleEventId = await createRecurringAppleCalendarEvent(calendarId, action, ruleId);
      // TOCTOU: the rule could be undone while the create was in flight — drop
      // the orphan event and abort the attach (nothing applied locally yet).
      if (discardAppleEventIfRuleGone(ruleId, appleEventId)) return false;
      // Link FIRST, then the rule. setAppleLink publishes synchronously, but
      // zustand notifies subscribers synchronously too — so updating the rule
      // first would let a re-render triggered by it read the OLD link in the
      // gap between these two statements. Writing the link first closes that
      // window; after this line no reader can see the new event id on the rule
      // paired with a stale local link.
      void setAppleLink(ruleId, appleEventId).catch(() => {});
      // Atomic apply: block + event link together (one re-key-free scalar patch).
      state.updateRecurringRule?.(ruleId, { preferredTimeBlock: block, appleEventId });
      haptic('voiceSuccess');
      return true;
    } catch {
      // Calendar denied / unavailable / create failed → atomic: apply nothing.
      return false;
    }
  }, []);

  // NEX-206 (Or-3): revert a just-accepted time block — clears the block + unlinks
  // and deletes the event WE created (futureEvents), atomically. Best-effort on the
  // Apple side (never throws into the UI), mirroring onUndoItem.
  const onUndoTimeBlock = useCallback(async (item: LedgerItem) => {
    const ruleId = item.suggestTimeBlock?.ruleId;
    if (!ruleId) return;
    haptic('buttonSecondary');
    const state = useAppState.getState();
    const rule = (Array.isArray(state.recurringRules) ? state.recurringRules : []).find((r) => r?.id === ruleId);
    // getAppleLink is a synchronous cache read that returns null until the
    // store has loaded. Right after a cold start that makes undo a no-op on
    // the calendar side: it would clear the time block but neither delete this
    // device's event nor clear the mirror, orphaning an event that a later
    // reconcile could adopt back. Hydrate first.
    await hydrateAppleLinks().catch(() => ({}));

    // Delete OUR event, not the shared mirror. The mirror is last-writer-wins
    // across devices, so it can hold an identifier minted elsewhere — passing
    // that to deleteEventAsync targets the wrong event (or nothing) while this
    // device's real event is left orphaned in the calendar.
    const ownEventId = getAppleLink(ruleId);
    const mirror = rule?.appleEventId ?? null;
    // Only clear the mirror when it is ours to clear; otherwise we would wipe
    // another device's association as a side effect of our undo.
    const mirrorIsOurs = !mirror || (!!ownEventId && mirror === ownEventId);

    // Clear block + unlink in one patch (revert to the prior null-block state).
    // Releasing the STORED link matters as much as the mirror: the event is
    // deleted just below, so a link left pointing at it would make the next
    // reconcile read 'mine' + 'missing' and delete the whole routine.
    state.updateRecurringRule?.(ruleId, {
      preferredTimeBlock: null,
      ...(mirrorIsOurs ? { appleEventId: null } : {}),
    });
    // ORDER MATTERS. Release the local link BEFORE deleting the native event.
    // Fire-and-forget left the old link visible while deleteEventAsync ran —
    // and link-store writes are serialized, so the release could queue behind
    // an earlier write. A reconcile landing in that window would see an owned
    // link whose event had just been deleted, take the 'mine' + 'missing'
    // branch, and remove the whole routine instead of just its time block.
    await clearAppleLink(ruleId).catch(() => {});
    if (ownEventId) {
      void Calendar.deleteEventAsync(String(ownEventId), { futureEvents: true }).catch(() => {});
    }
  }, []);

  // NEX-210 (C-5): break a vague inbox capture into steps. Remembers the grain,
  // runs the AI breakdown, lands the steps as inbox one-offs (the original
  // capture is left untouched), and resolves the step titles + their ids for the
  // ledger's result/undo. Any failure resolves empty → the offer shows a no-blame
  // retry. Device-only to exercise (SIM_BYPASS → the proxy 401s on the simulator).
  const onAcceptBreakdown = useCallback(
    async (item: LedgerItem, grain: BreakdownGrain): Promise<{ steps: string[]; ids: string[] }> => {
      const title = item.suggestBreakdown?.title;
      if (!title) return { steps: [], ids: [] };
      const state = useAppState.getState();
      // Remember the grain for next time (synced pref; see app-state mirror).
      state.setBreakdownGrain?.(grain);
      let steps: string[] = [];
      try {
        steps = await breakdownIntoSteps(title, grain);
      } catch {
        steps = [];
      }
      if (!steps.length) return { steps: [], ids: [] };
      // NEX-285: pass the goal title so the steps land as one stacked group.
      const ids: string[] = state.addBrokenDownSteps?.(steps, title) ?? [];
      if (ids.length) haptic('voiceSuccess');
      return { steps, ids };
    },
    [],
  );

  // NEX-210 (C-5): revert a just-landed breakdown — delete the steps WE created
  // (by id). The original capture was never touched, so there is nothing to
  // restore. Idempotent: re-breaking after an undo creates fresh ids.
  const onUndoBreakdown = useCallback((_item: LedgerItem, stepIds: string[]) => {
    haptic('buttonSecondary');
    const state = useAppState.getState();
    for (const id of stepIds) state.deleteInboxTask?.(id);
  }, []);

  const onRetryItem = useCallback(
    async (item: LedgerItem, index: number) => {
      if (item.retryType !== 'recurring_apple_sync' || !item.recurringRuleId || !item.actionPayload) {
        Alert.alert('Retry Unavailable', 'This ledger item cannot be retried.');
        return;
      }
      if (!recurringRuleExists(item.recurringRuleId)) {
        // Rule was undone — drop the retry affordance instead of orphaning an event.
        setExecutionLedger((prev) =>
          Array.isArray(prev)
            ? prev.map((entry, idx) => (idx === index ? { ...entry, retryType: undefined } : entry))
            : prev,
        );
        return;
      }
      const retryKey = item.key;
      if (retryingLedgerKeys.includes(retryKey)) return;
      setRetryingLedgerKeys((prev) => [...prev, retryKey]);
      try {
        const calendarId = await ensureWritableCalendar();
        const appleEventId = await createRecurringAppleCalendarEvent(calendarId, item.actionPayload, item.recurringRuleId);
        // Re-check AFTER the in-flight create: undone mid-flight → drop the orphan.
        if (discardAppleEventIfRuleGone(item.recurringRuleId, appleEventId)) {
          setExecutionLedger((prev) =>
            Array.isArray(prev)
              ? prev.map((entry, idx) => (idx === index ? { ...entry, retryType: undefined } : entry))
              : prev,
          );
          return;
        }
        attachAppleEventToRecurringRule(item.recurringRuleId, appleEventId);
        setExecutionLedger((prev) =>
          Array.isArray(prev)
            ? prev.map((entry, idx) =>
                idx === index
                  ? {
                      ...entry,
                      status: 'success' as const,
                      // NEX-194: preserve the today-only default note if this rule
                      // was schedule-defaulted, so a successful retry doesn't hide
                      // the cadence explanation. (Greptile #135.)
                      detail: `Added to Orbit and synced to Apple Calendar on retry.${
                        entry?.scheduleDefaulted ? SCHEDULE_DEFAULTED_NOTE : ''
                      }`,
                      retryType: undefined,
                    }
                  : entry,
              )
            : prev,
        );
        haptic('voiceSuccess');
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Retry failed.';
        setExecutionLedger((prev) =>
          Array.isArray(prev)
            ? prev.map((entry, idx) =>
                idx === index ? { ...entry, status: 'partial' as const, detail: `Retry failed: ${message}` } : entry,
              )
            : prev,
        );
        haptic('voiceAmbiguous');
      } finally {
        setRetryingLedgerKeys((prev) => prev.filter((key) => key !== retryKey));
      }
    },
    [retryingLedgerKeys],
  );

  const silentlyRetryPendingAppleSyncs = useCallback(async () => {
    const attempts = silentAppleSyncRetryAttemptsRef.current;
    const pendingItems = (executionLedger ?? []).filter((item) =>
      isPendingAppleSync(item, retryingLedgerKeys, attempts),
    );
    if (!pendingItems.length || silentAppleSyncRetryInFlightRef.current) return;
    silentAppleSyncRetryInFlightRef.current = true;
    try {
      for (const item of pendingItems) {
        const key = item.key;
        const priorAttempts = attempts[key] ?? 0;
        if (priorAttempts >= 1) continue;
        // Greptile P: skip (and clear the retry) if the rule was undone since
        // the partial — don't create an Apple event for a deleted rule.
        if (!recurringRuleExists(item.recurringRuleId!)) {
          attempts[key] = priorAttempts + 1;
          clearRetryOnLedger(key);
          continue;
        }
        attempts[key] = priorAttempts + 1;
        try {
          const calendarId = await ensureWritableCalendar();
          const appleEventId = await createRecurringAppleCalendarEvent(calendarId, item.actionPayload!, item.recurringRuleId!);
          if (!appleEventId) throw new Error('Apple Calendar event was not created.');
          // Re-check AFTER the in-flight create: undone mid-flight → drop the orphan.
          if (discardAppleEventIfRuleGone(item.recurringRuleId!, appleEventId)) {
            clearRetryOnLedger(key);
            continue;
          }
          attachAppleEventToRecurringRule(item.recurringRuleId!, appleEventId);
          setExecutionLedger((prev) =>
            Array.isArray(prev)
              ? prev.map((entry) =>
                  entry?.key === key
                    ? {
                        ...entry,
                        status: 'success' as const,
                        // NEX-194: keep the today-only default note on silent
                        // auto-retry success too, not just manual retry. (Greptile #135.)
                        detail: `Apple sync restored${entry?.scheduleDefaulted ? SCHEDULE_DEFAULTED_NOTE : ''}`,
                      }
                    : entry,
                )
              : prev,
          );
        } catch {
          setExecutionLedger((prev) =>
            Array.isArray(prev)
              ? prev.map((entry) =>
                  entry?.key === key
                    ? {
                        ...entry,
                        status: entry?.status === 'failed' ? ('failed' as const) : ('partial' as const),
                        detail: `${entry?.detail || 'Apple sync pending'} - waiting for retry`,
                      }
                    : entry,
                )
              : prev,
          );
        }
      }
    } finally {
      silentAppleSyncRetryInFlightRef.current = false;
    }
  }, [executionLedger, retryingLedgerKeys, clearRetryOnLedger]);

  useEffect(() => {
    const hasPendingAppleSync =
      Array.isArray(executionLedger) &&
      executionLedger.some((item) =>
        isPendingAppleSync(item, retryingLedgerKeys, silentAppleSyncRetryAttemptsRef.current),
      );
    if (!hasPendingAppleSync) return;
    const timer = setTimeout(() => { void silentlyRetryPendingAppleSyncs(); }, 2500);
    return () => clearTimeout(timer);
  }, [executionLedger, retryingLedgerKeys, silentlyRetryPendingAppleSyncs]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') void silentlyRetryPendingAppleSyncs();
    });
    return () => { subscription?.remove?.(); };
  }, [silentlyRetryPendingAppleSyncs]);

  // NEX-197: executes a tier-resolved action list directly — no review form,
  // no EXECUTE button. Called from the high path and from a clarification chip.
  // Re-entrancy matters MORE without a button: a duplicated final-transcript
  // event must not double-write, so we guard on the lock AND the proposal key.
  const executeActions = useCallback(
    async (actions: ProposedAction[]): Promise<boolean> => {
      if (!actions || actions.length === 0) return false;
      if (isExecuting || executionLockRef.current) return false;
      const proposalKey = getProposalExecutionKey(actions);
      const nowMs = Date.now();
      // Block only a rapid duplicate of the SAME capture (within 3s); a deliberate
      // re-run of the same command after that is allowed. Set synchronously, before
      // any await, so a near-simultaneous second call sees it.
      if (lastExecRef.current && lastExecRef.current.key === proposalKey && nowMs - lastExecRef.current.at < 3000) {
        return false;
      }
      lastExecRef.current = { key: proposalKey, at: nowMs };
      executionLockRef.current = true;
      setIsExecuting(true);
      try {
        haptic('dragDrop');
        onExecuteStartRef.current?.();
        setExecutionLedger(null);
        const liveState = useAppState.getState();
        const appStateBag: ExecutorAppState = {
          pillars: Array.isArray(liveState.pillars) ? liveState.pillars : [],
          // Phase 4: addInboxTask now returns the new id and accepts
          // an options object. updateInboxTask is exposed so the
          // mirror flow can stamp source+externalId.
          addInboxTask: (title, opts) => liveState.addInboxTask(title, opts),
          updateInboxTask: (id, patch) => liveState.updateInboxTask(id, patch),
          addRecurringRule: liveState.addRecurringRule,
          addRecurringToDo: liveState.addRecurringToDo,
          addDailyTask: liveState.addDailyTask,
          setPillars: (pillars) => useAppState.setState({ pillars: pillars as Pillar[] }),
          // NEX-195 (Greptile P1): functional prepend so multiple align actions
          // in one proposal each append against the LIVE pillar list.
          addPillar: (pillar) =>
            useAppState.setState((state) => ({
              pillars: [pillar as Pillar, ...(Array.isArray(state.pillars) ? state.pillars : [])],
            })),
          // NEX-195 (Greptile P1): orphaned-reminder guard for the async mirror
          // race — the executor checks the local task still exists before
          // stamping it, and drops the just-created reminder if it was undone.
          hasInboxTask: (id) =>
            (Array.isArray(useAppState.getState().inbox) ? useAppState.getState().inbox : []).some(
              (t) => t?.id === id,
            ),
          deleteMirroredReminder: (externalId) => {
            void useRemindersStore.getState().deleteMirroredReminder(externalId);
          },
          // Routed through attachAppleEventToRecurringRule so the command path
          // stamps device provenance exactly like the direct path does.
          linkRecurringRuleToAppleEvent: attachAppleEventToRecurringRule,
        };
        const { ledger } = await executeProposedActions({
          proposedActions: actions,
          appState: appStateBag,
          ensureWritableCalendar,
          createCalendarEvent: createCalendarEventCb,
          createRecurringAppleCalendarEvent,
          // Phase 4: voice-mirror to Apple Reminders. Resolves to
          // null on any non-fatal skip (not connected, no Nexus
          // list, EventKit failure) so the executor's local mutation
          // is unaffected.
          mirrorToReminders: (input) =>
            useRemindersStore.getState().mirrorToReminders({
              title: input.title,
              dueDate: input.dueDate,
              notes: input.notes,
            }),
        });
        // NEX-222: north-star metric 1 denominator — emit item_captured for each
        // committed capture (consent-gated via trackEvent; PII-free props only).
        // entityId is the opaque capture_id; calendar rows (no entityId) are excluded.
        // AWAIT sequentially: trackEvent does a load-append-persist on a shared
        // event log, and concurrent calls on a cold cache last-writer-wins (dropping
        // rows). Awaiting each warms the cache so the next append sees the prior one.
        {
          const capturedDayKey = getLocalDateKey(new Date());
          for (const c of extractCaptures(ledger)) {
            await trackEvent('item_captured', {
              capture_id: c.captureId,
              item_type: c.itemType,
              capture_surface: c.surface,
              // NEX-200: where the capture was initiated (the Eye / typed input on
              // Command, or the coach thread). The Home quick-add bar emits 'home'.
              capture_origin: captureOrigin,
              local_day_key: capturedDayKey,
            });
            // NEX-261: register the capture so the first-reach tracker can later
            // emit captured_item_first_reached exactly once (surfaced or manual_nav).
            void recordCapture(c.captureId);
          }
        }
        const hasFailed = ledger.some((item) => item.status === 'failed');
        const hasPartial = ledger.some((item) => item.status === 'partial');
        if (hasFailed || hasPartial) {
          // Per chat 2026-05-18: notification.Error banned for routine; downgrade to Warning (voiceAmbiguous).
          haptic('voiceAmbiguous');
        } else {
          haptic('voiceSuccess');
        }
        // NEX-194 seam: the ledger is the interim one-line confirmation. When the
        // save-and-surface pipeline lands, the high path also injects the item as
        // Home's top Today row before this confirmation shows.
        // NEX-195 seam: replace this ledger with the location-bearing confirmation
        // + one-tap undo/jump.
        setExecutionLedger(ledger);
        if (!hasFailed && !hasPartial) {
          // Screen chrome first (first-run flag, scroll, "Added." flash), then
          // the announcement, then the Home echo: the order the Command screen
          // always had, kept so the scroll-end accessibility event lands before
          // the "Added." utterance rather than clipping it.
          onExecuteSuccessRef.current?.(ledger);
          announce('Added.');
          // NEX-196: echo a just-captured one-off on Home. Take the LAST inbox_add
          // success row with an entityId (a command can emit several). The chip
          // shows it until viewed/undone/cleared (validity-gated, no timer). One-
          // off only: habits self-surface (NEX-194), dated todos surface in Orbit.
          const inboxRow = [...ledger]
            .reverse()
            .find((it) => it.type === 'inbox_add' && it.status === 'success' && !!it.entityId);
          if (inboxRow?.entityId) {
            useAppState.getState().setJustCaptured?.({
              id: inboxRow.entityId,
              title: inboxRow.title,
              surface: 'inbox',
            });
          } else {
            // A later successful command with no one-off retires any prior echo,
            // so the chip reflects the most recent command (not a stale capture).
            useAppState.getState().clearJustCaptured?.();
          }
        }
      } catch (err: unknown) {
        // Per chat 2026-05-18: notification.Error banned for routine; downgrade to Warning (voiceAmbiguous).
        haptic('voiceAmbiguous');
        const message = err instanceof Error ? err.message : 'Unable to execute action plan.';
        setExecutionLedger([{ key: 'system', title: 'Execution Blocked', type: 'system', status: 'failed', detail: message }]);
        Alert.alert('Execution Blocked', message);
      } finally {
        executionLockRef.current = false;
        setIsExecuting(false);
      }
      return true;
    },
    [isExecuting, captureOrigin],
  );

  const dismissLedger = useCallback(() => setExecutionLedger(null), []);

  return {
    executionLedger,
    isExecuting,
    retryingLedgerKeys,
    breakdownGrain,
    executeActions,
    dismissLedger,
    onRetryItem,
    onUndoItem,
    onJumpItem,
    onAcceptTimeBlock,
    onUndoTimeBlock,
    onAcceptBreakdown,
    onUndoBreakdown,
    ensureWritableCalendar,
    createRecurringAppleCalendarEvent,
    attachAppleEventToRecurringRule,
  };
}
