/**
 * command-executor.ts
 *
 * Turns a validated list of ProposedActions into actual app mutations.
 * This module owns the "what to do" logic; the Command screen owns
 * "when to do it" (lock, haptics, React state).
 *
 * Design constraints:
 * - No React imports — plain async TypeScript.
 * - No direct Zustand access; receives an `appState` bag of action-functions
 *   so callers can inject the real store or a test double.
 * - All native Calendar calls are injected as callbacks; this file has
 *   zero native/expo-calendar dependencies.
 * - Apple Calendar sync failures downgrade the result to "partial" and
 *   surface a `retryType` so the screen can offer a retry button.
 *
 * Refs #4.
 */

import { ProposedAction } from './command-types';
import type { TimeBlock } from '../../utils/recurrence';
import { buildMirrorPayload } from '../../state/should-mirror-action';
import { buildReminderDueIso } from '../../state/reminder-schedule';
import { looksBreakable } from './breakdown';
import {
  defaultDaysOfWeek,
  isScheduleDefaulted,
  SCHEDULE_DEFAULTED_NOTE,
} from './scheduling-default';

// ─── Ledger types (canonical home) ───────────────────────────────────────────

export type LedgerStatus = 'success' | 'failed' | 'partial';

export interface LedgerItem {
  /** Stable key for React list rendering and retry lookup. */
  key: string;
  title: string;
  type: string;
  status: LedgerStatus;
  detail: string;
  /** Set when a background Apple Calendar retry is possible. */
  retryType?: 'recurring_apple_sync';
  recurringRuleId?: string | null;
  /** Preserved for retry payloads. */
  actionPayload?: ProposedAction | null;
  // NEX-194: the thread the NEX-195 location-bearing confirmation + undo/jump
  // will consume. `entityId` is the id of the created store entity (e.g. the
  // recurring rule id returned by addRecurringRule); `surface` is where it
  // landed so the confirmation can say "On your Home, under Today." and jump.
  entityId?: string;
  surface?: 'home_today' | 'inbox' | 'orbit' | 'align' | 'calendar';
  // NEX-195: the resolved Align category (BUSINESS/VISION/PERSONAL) so the
  // location-bearing headline can name it ("In Align, under Vision."). Lives
  // here rather than on actionPayload because `category` is not a field on
  // ProposedAction.
  category?: string;
  // NEX-194: true when a recurring habit's cadence was AMBIGUOUS (empty/missing
  // daysOfWeek) and we defaulted it to today-only to surface it now. The
  // confirmation says so (not a silent guess) and NEX-195 offers a one-tap
  // "set the days" refinement off this flag.
  scheduleDefaulted?: boolean;
  // NEX-206 (Or-3): present when this result is a bare time-less habit that
  // landed on Today — the confirmation ledger renders a one-tap "offer a time"
  // row from it (primary chip = current daypart + alternates). Ephemeral and
  // NOT persisted: the offer lives with the ledger and is gone on restart by
  // design ("offer once, no nag"). `ruleId` is the created recurring rule;
  // accept applies the block + syncs Apple Calendar atomically (see index.tsx).
  suggestTimeBlock?: { ruleId: string; suggestedBlock: TimeBlock };
  // NEX-210 (C-5): present when a captured intention looks vague/large — the
  // confirmation ledger renders a one-tap "break into steps?" offer (grain chips
  // → AI breakdown → N inbox one-offs). Ephemeral / offer-only / dies with the
  // ledger (no nag); breakdown never auto-runs. `title` is the intention to break.
  suggestBreakdown?: { title: string };
}

// ─── NEX-206: time-block suggestion (pure decision) ──────────────────────────

/**
 * Map an hour-of-day (0–23) to the wide time block we suggest by default.
 * Boundaries align with TIME_BLOCK_DEFAULTS in recurring-event-time.ts
 * (morning 09:00 / afternoon 13:00 / evening 17:00 / night 20:00): a capture
 * made inside a block's window suggests that block. Night wraps midnight.
 */
export function timeBlockForHour(hour: number): TimeBlock {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 20) return 'evening';
  return 'night'; // 20:00–04:59
}

/**
 * The pure decision behind the confirmation ledger's "offer a time" affordance
 * (NEX-206 / Or-3). Returns the suggested block for a bare time-less habit that
 * landed on Today, or `null` when no offer applies.
 *
 * Only a `recurring_add` that lands on `home_today` with NO clock time and NO
 * preferredTimeBlock qualifies — a habit that already carries a time/block was
 * placed deliberately and is never re-offered. The suggested block is the
 * current daypart so the one-tap accept reads as "right now's" block.
 */
export function buildTimeBlockSuggestion(
  action: Pick<ProposedAction, 'type' | 'time' | 'preferredTimeBlock'>,
  surface: LedgerItem['surface'],
  now: Date,
): TimeBlock | null {
  if (action.type !== 'recurring_add') return null;
  if (surface !== 'home_today') return null;
  if (action.time || action.preferredTimeBlock) return null;
  return timeBlockForHour(now.getHours());
}

// ─── AppState dependency bag ──────────────────────────────────────────────────
//
// Executor receives a plain object of store methods.
// This decouples it from Zustand and makes unit-testing trivial.

export interface ExecutorAppState {
  pillars: unknown[];
  // Phase 4: addInboxTask returns the new task id so inbox_add /
  // todo_add can stamp source+externalId after the mirror resolves.
  addInboxTask: (
    title: string,
    options?: { dueDate?: string; source?: 'manual' | 'apple_reminders'; status?: string },
  ) => string;
  // Phase 4: patch update used by the voice-mirror flow.
  updateInboxTask: (
    id: string,
    patch: {
      title?: string;
      source?: 'manual' | 'apple_reminders';
      externalId?: string;
      dueDate?: string;
    },
  ) => void;
  addRecurringRule: (
    title: string,
    daysOfWeek: number[],
    time?: string | null,
    preferredTimeBlock?: string | null,
    cal?: string,
    appleEventId?: string | null,
    timesPerDay?: number | null
  ) => string;
  addRecurringToDo: (title: string, daysOfWeek: number[], interval?: number) => string;
  addDailyTask: (title: string, dateStr: string) => void;
  setPillars: (pillars: unknown[]) => void;
  // NEX-195 (Greptile P1): functional prepend so multiple `align` actions in
  // ONE proposal each append against the CURRENT pillar list. setPillars from
  // the pre-execution `pillars` snapshot lost the first-created pillar.
  addPillar: (pillar: unknown) => void;
  // NEX-195 (Greptile P1): orphaned-reminder guard for the async mirror race.
  // If the local inbox task was undone before the mirror resolved, the
  // just-created Apple Reminder would be orphaned. The executor checks
  // existence and best-effort deletes the reminder. Optional — the flow
  // degrades to the prior behavior when not injected.
  hasInboxTask?: (id: string) => boolean;
  deleteMirroredReminder?: (externalId: string) => void;
  linkRecurringRuleToAppleEvent?: (ruleId: string, appleEventId: string) => void;
}

/**
 * Phase 4 voice-mirror callback. Injected by the Command screen so
 * the executor stays decoupled from the reminders store. Returns
 * { externalId } on success, null on any non-fatal skip (not
 * connected, no Nexus list, EventKit failure).
 */
export type MirrorToRemindersFn = (input: {
  type: 'inbox_add' | 'todo_add';
  title: string;
  dueDate?: string;
  notes?: string;
}) => Promise<{ externalId: string } | null>;

// ─── Native callback types ────────────────────────────────────────────────────

/**
 * Creates a one-off Apple Calendar event.
 * Injected by the Command screen; wraps Calendar.createEventAsync.
 */
export type CreateCalendarEventFn = (
  calendarId: string,
  action: ProposedAction
) => Promise<void>;

/**
 * Creates a recurring Apple Calendar event and returns the new event ID.
 * Injected by the Command screen.
 */
export type CreateAppleRecurringEventFn = (
  calendarId: string,
  action: ProposedAction,
  orbitRuleId: string
) => Promise<string>;

/**
 * Acquires a writable Apple Calendar ID (requests permission if needed).
 * Throws if access is denied or no writable calendar exists.
 */
export type EnsureWritableCalendarFn = () => Promise<string>;

// ─── Input / Output ───────────────────────────────────────────────────────────

export interface ExecuteProposedActionsInput {
  proposedActions: ProposedAction[];
  appState: ExecutorAppState;
  ensureWritableCalendar: EnsureWritableCalendarFn;
  createCalendarEvent: CreateCalendarEventFn;
  createRecurringAppleCalendarEvent: CreateAppleRecurringEventFn;
  /**
   * Phase 4 voice-mirror. Optional — when omitted (or returning null),
   * the executor skips the Apple Reminders write and the local item
   * stays manual-source. Always called after the local mutation, so
   * even an EventKit failure leaves the user's voice capture intact.
   */
  mirrorToReminders?: MirrorToRemindersFn;
}

export interface ExecuteProposedActionsResult {
  ledger: LedgerItem[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Stable string key that uniquely identifies a proposal snapshot.
 * Used by the duplicate-execution guard in the Command screen.
 */
export function getProposalExecutionKey(actions: ProposedAction[]): string {
  return JSON.stringify(
    actions.map((action) => ({
      type: action.type,
      title: action.title,
      // NEX-225: notes/description is execution-affecting (it writes to the
      // created entity), so two captures of the same title that differ only by
      // description are distinct and must not collide in the dedup key.
      description: action.description ?? null,
      startISO: action.startISO ?? null,
      endISO: action.endISO ?? null,
      dateStr: action.dateStr ?? null,
      time: action.time ?? null,
      preferredTimeBlock: action.preferredTimeBlock ?? null,
      daysOfWeek: Array.isArray(action.daysOfWeek) ? [...action.daysOfWeek].sort() : [],
      // NEX-225: frequency must be part of the dedup key. Two captures that
      // differ ONLY by frequency (e.g. "read my mantras twice a day" then
      // "...three times a day", or a weekly vs biweekly recurring_todo_add of
      // the same title) would otherwise produce an identical key and the second
      // gets dropped as a duplicate. Latent while every capture went through the
      // AI; the Tier-1 offline grammar (NEX-223) now parses timesPerDay/interval
      // deterministically, making the collision easy to hit on rapid captures.
      timesPerDay: action.timesPerDay ?? null,
      interval: action.interval ?? null,
      nextAction: action.nextAction ?? null,
    }))
  );
}

/**
 * NEX-195 (Greptile P1): resolve a voice-mirror promise SAFELY against the
 * undo race. The mirror resolves asynchronously, after the local inbox task is
 * already undoable. If the user tapped UNDO first, the local row is gone — so
 * stamping it would resurrect nothing, and the Apple Reminder the mirror just
 * created would be orphaned. Guard: when the task no longer exists, best-effort
 * delete the just-created reminder instead of writing to a dead row. Shared by
 * inbox_add and todo_add.
 */
function resolveMirrorResult(
  appState: ExecutorAppState,
  localId: string,
  result: { externalId: string } | null,
): void {
  const stillExists = appState.hasInboxTask ? appState.hasInboxTask(localId) : true;
  if (!stillExists) {
    if (result?.externalId) appState.deleteMirroredReminder?.(result.externalId);
    return;
  }
  if (result?.externalId) {
    appState.updateInboxTask(localId, {
      source: 'apple_reminders',
      externalId: result.externalId,
    });
  } else {
    appState.updateInboxTask(localId, { source: 'manual' });
  }
}

// ─── Main executor ────────────────────────────────────────────────────────────

/**
 * Execute a validated list of ProposedActions.
 *
 * Returns a ledger describing the outcome of every action.
 * Never throws — all errors are captured into ledger entries.
 */
export async function executeProposedActions({
  proposedActions,
  appState,
  ensureWritableCalendar,
  createCalendarEvent,
  createRecurringAppleCalendarEvent,
  mirrorToReminders,
}: ExecuteProposedActionsInput): Promise<ExecuteProposedActionsResult> {
  const results: Omit<LedgerItem, 'key'>[] = [];

  // ── Pre-flight: acquire writable calendar once if any action needs it ──
  let writableCalendarId: string | null = null;
  let calendarSetupError: string | null = null;

  // Habits with only timesPerDay (no time / no preferredTimeBlock) are
  // identity-tracked on the Home habits list — no clock time, no Apple
  // Calendar entry. Don't acquire calendar permission for them.
  const needsCalendar = proposedActions.some(
    (a) =>
      a.type === 'calendar_add' ||
      (a.type === 'recurring_add' && (!!a.time || !!a.preferredTimeBlock))
  );

  if (needsCalendar) {
    try {
      writableCalendarId = await ensureWritableCalendar();
    } catch (err: unknown) {
      calendarSetupError =
        err instanceof Error ? err.message : 'Calendar access is unavailable.';
    }
  }

  // ── Per-action execution loop ──────────────────────────────────────────
  for (const action of proposedActions) {
    try {
      switch (action.type) {
        // ── calendar_add ────────────────────────────────────────────────
        // No Apple Reminders mirror — calendar_add belongs in Orbit. The whole
        // action is forwarded, so a nested `recurrence` object (a TIMED recurring
        // block) flows through to createCalendarEvent, which now writes a real
        // repeating Apple Calendar event; a one-off action carries no recurrence.
        // Stays jump-only with no undo either way (see NEX-195 note below).
        case 'calendar_add': {
          if (!writableCalendarId) {
            throw new Error(
              calendarSetupError ?? 'Calendar access is required to add calendar events.'
            );
          }
          if (!action.startISO || !action.endISO) {
            throw new Error('Calendar event is missing a start or end time.');
          }

          await createCalendarEvent(writableCalendarId, action);

          results.push({
            title: action.title || 'Untitled Action',
            type: action.type,
            status: 'success',
            detail: 'Added to Apple Calendar.',
            // NEX-195: jump-only (a raw Apple event has no Nexus entity to
            // undo — deleting the user's real calendar event on an undo tap
            // would be a §1.5 Law E unrecoverable mistake).
            surface: 'calendar',
          });
          break;
        }

        // ── inbox_add ───────────────────────────────────────────────────
        // Phase 4.3 defensive: inbox_add by definition has no schedule.
        // The model occasionally hallucinates dateStr/time on captures
        // like "think about Q1 strategy" — buildMirrorPayload strips
        // those fields by omission. The local addInboxTask call
        // likewise never reads action.dateStr / action.time so the
        // local card matches the mirrored reminder (no due date).
        case 'inbox_add': {
          const willMirror = !!mirrorToReminders;
          const localId = appState.addInboxTask(action.title, {
            source: willMirror ? 'apple_reminders' : 'manual',
            status: 'UNPROCESSED',
            // Intentionally NOT passing dueDate. inbox_add has no schedule.
          });
          if (willMirror && mirrorToReminders) {
            const payload = buildMirrorPayload({
              type: 'inbox_add',
              title: action.title,
            });
            if (payload) {
              void mirrorToReminders({ type: 'inbox_add', title: payload.title })
                .then((result) => resolveMirrorResult(appState, localId, result))
                .catch(() => {
                  // Mirror failed: no reminder was created, so nothing to
                  // orphan. Stamp manual if the task still exists (no-op if undone).
                  if (!appState.hasInboxTask || appState.hasInboxTask(localId)) {
                    appState.updateInboxTask(localId, { source: 'manual' });
                  }
                });
            }
          }
          results.push({
            title: action.title || 'Untitled Action',
            type: action.type,
            status: 'success',
            detail: action.description || 'Added to Inbox.',
            // NEX-195: thread for the location-bearing confirmation + undo.
            // The mirrored reminder's externalId is stamped async (see above),
            // so undo reads it LIVE off the inbox task at tap time.
            entityId: localId,
            surface: 'inbox',
            // NEX-210: a vague/large capture gets a one-tap "break into steps?"
            // offer on the ledger (offer-only; never auto-breaks).
            ...(looksBreakable(action.title) ? { suggestBreakdown: { title: action.title } } : {}),
          });
          break;
        }

        // ── align ───────────────────────────────────────────────────────
        // No Apple Reminders mirror — align is identity work, not a to-do.
        case 'align': {
          const rawCat =
            typeof (action as unknown as Record<string, unknown>).category === 'string'
              ? String((action as unknown as Record<string, unknown>).category).toUpperCase().trim()
              : 'BUSINESS';
          const validCats = ['BUSINESS', 'VISION', 'PERSONAL'] as const;
          const safeCat = (validCats as readonly string[]).includes(rawCat)
            ? (rawCat as 'BUSINESS' | 'VISION' | 'PERSONAL')
            : 'BUSINESS';

          const newPillar = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            title: action.title,
            category: safeCat,
            type: 'ACTION',
            power: 0,
            completed: false,
            subtext: safeCat,
          };

          // Functional prepend (NOT setPillars from the stale snapshot) so two
          // align actions in one proposal both survive (Greptile P1).
          appState.addPillar(newPillar);
          results.push({
            title: action.title || 'Untitled Action',
            type: action.type,
            status: 'success',
            detail: `Added to Align → ${safeCat}.`,
            // NEX-195: thread for the location-bearing confirmation + undo.
            entityId: newPillar.id,
            surface: 'align',
            category: safeCat,
          });
          break;
        }

        // ── recurring_add ───────────────────────────────────────────────
        // No Apple Reminders mirror — recurring_add belongs in Orbit/Habits.
        case 'recurring_add': {
          // A habit with only timesPerDay is tracked on the Home habits list
          // (no clock time → nothing to sync to Apple Calendar). A timed
          // routine (has `time` or `preferredTimeBlock`) still syncs.
          const shouldSyncToAppleCalendar = !!(action.time || action.preferredTimeBlock);

          // NEX-194 (save-and-surface): empty/missing days default to
          // TODAY-ONLY (not every-day) so the habit renders on Home's
          // Today's Habits the same day without corrupting the alignment
          // score / streaks. See scheduling-default.ts.
          //
          // Compute the defaulted days ONCE and write them back onto the
          // action, so the local rule, the Apple Calendar event (which derives
          // its own days from action.daysOfWeek), AND any later retry
          // (actionPayload = this action) all agree. Without this, the Apple
          // event's own empty→today fallback would recompute today AT RETRY
          // TIME — a different day than the local rule's create-day today.
          const resolvedDaysOfWeek = defaultDaysOfWeek(action.daysOfWeek);
          const resolvedAction: ProposedAction = { ...action, daysOfWeek: resolvedDaysOfWeek };

          // NEX-194: when the days were AMBIGUOUS (the parser emits daysOfWeek:[]
          // + missingFields:["daysOfWeek"] only when it genuinely can't tell),
          // we still default to today-only so the habit surfaces now — but we do
          // NOT do it silently: the confirmation says so and offers the change.
          // This reconciles "surface-first" (§1.5 Law A) with "don't silently
          // guess an ambiguous cadence" — the full one-tap refinement is NEX-195.
          const scheduleDefaulted = isScheduleDefaulted(action.daysOfWeek);
          // Tag the single result this case pushes so an ambiguous-cadence habit
          // announces the today-only default + how to change it (not silent).
          // Called before EVERY break in this case — including the no-Apple-sync
          // early return — so the note is never dropped. (Greptile #135.) The
          // shared SCHEDULE_DEFAULTED_NOTE is reused by the Apple-sync retry-
          // success update so the note survives a retry rewrite of the detail.
          const tagScheduleDefault = () => {
            if (!scheduleDefaulted) return;
            const last = results[results.length - 1];
            if (last) {
              last.scheduleDefaulted = true;
              last.detail = `${last.detail}${SCHEDULE_DEFAULTED_NOTE}`;
            }
          };

          const recurringRuleId = appState.addRecurringRule(
            resolvedAction.title,
            resolvedDaysOfWeek,
            resolvedAction.time ?? null,
            resolvedAction.preferredTimeBlock ?? null,
            'ROUTINE',
            null,
            typeof resolvedAction.timesPerDay === 'number' ? resolvedAction.timesPerDay : null
          );

          if (!shouldSyncToAppleCalendar) {
            // NEX-206 (Or-3): a bare time-less habit lands on Today and the
            // confirmation ledger offers a one-tap suggested block (current
            // daypart) rather than silently inserting a clock time. The pure
            // decision returns the block here in every case this branch is
            // reached (recurring_add, home_today, no time/block); the spread
            // stays defensive so the offer is driven by one source of truth.
            const suggestedBlock = buildTimeBlockSuggestion(action, 'home_today', new Date());
            results.push({
              title: action.title || 'Untitled Action',
              type: action.type,
              status: 'success',
              detail: 'Added to Home page habits.',
              // NEX-194: thread for the NEX-195 confirmation + undo/jump.
              entityId: recurringRuleId,
              surface: 'home_today',
              ...(suggestedBlock
                ? { suggestTimeBlock: { ruleId: recurringRuleId, suggestedBlock } }
                : {}),
            });
            tagScheduleDefault();
            break;
          }

          if (writableCalendarId) {
            try {
              const appleEventId = await createRecurringAppleCalendarEvent(
                writableCalendarId,
                resolvedAction,
                recurringRuleId
              );

              appState.linkRecurringRuleToAppleEvent?.(recurringRuleId, appleEventId);

              results.push({
                title: action.title || 'Untitled Action',
                type: action.type,
                status: 'success',
                detail: 'Added to Orbit and synced to Apple Calendar.',
                // NEX-194: same thread — the local rule also lands on Home today.
                entityId: recurringRuleId,
                surface: 'home_today',
              });
            } catch (syncErr: unknown) {
              const syncMessage =
                syncErr instanceof Error ? syncErr.message : 'Apple Calendar sync failed.';
              results.push({
                title: action.title || 'Untitled Action',
                type: action.type,
                status: 'partial',
                detail: `Added to Orbit, but Apple Calendar sync failed: ${syncMessage}`,
                retryType: 'recurring_apple_sync',
                recurringRuleId,
                // NEX-194: retry with the SAME defaulted days as the local rule.
                actionPayload: resolvedAction,
                // NEX-194: the local rule was still created and lands on Home today.
                entityId: recurringRuleId,
                surface: 'home_today',
              });
            }
          } else if (calendarSetupError) {
            results.push({
              title: action.title || 'Untitled Action',
              type: action.type,
              status: 'partial',
              detail: `Added to Orbit, but Apple Calendar sync failed: ${calendarSetupError}`,
              retryType: 'recurring_apple_sync',
              recurringRuleId,
              // NEX-194: retry with the SAME defaulted days as the local rule.
              actionPayload: resolvedAction,
              // NEX-194: the local rule was still created and lands on Home today.
              entityId: recurringRuleId,
              surface: 'home_today',
            });
          } else {
            results.push({
              title: action.title || 'Untitled Action',
              type: action.type,
              status: 'success',
              detail: 'Added recurring block to Orbit.',
              // NEX-194: the local rule also lands on Home today.
              entityId: recurringRuleId,
              surface: 'home_today',
            });
          }
          tagScheduleDefault();
          break;
        }

        // ── recurring_todo_add ──────────────────────────────────────────
        // No Apple Reminders mirror — recurring_todo_add lives in Orbit.
        // Pipes interval through so biweekly / every-N-weeks intent
        // ("every other Tuesday", "biweekly check-in") writes interval=2+
        // onto the rule. addRecurringToDo auto-stamps intervalAnchorDate
        // to today; the materializer in today-rollup respects both.
        // Defensive sanitization: cap at 12 weeks, floor at 1, default
        // to undefined (which addRecurringToDo treats as 1).
        case 'recurring_todo_add': {
          const rawInterval = (action as any).interval;
          const sanitizedInterval =
            typeof rawInterval === 'number' && Number.isFinite(rawInterval) && rawInterval >= 2
              ? Math.min(12, Math.round(rawInterval))
              : undefined;
          const recurringToDoId = appState.addRecurringToDo(
            action.title,
            action.daysOfWeek ?? [],
            sanitizedInterval,
          );
          results.push({
            title: action.title || 'Untitled Action',
            type: action.type,
            status: 'success',
            detail: 'Added recurring to-do.',
            // NEX-195: a scheduled to-do lives in Orbit (not a Home habit).
            entityId: recurringToDoId,
            surface: 'orbit',
          });
          break;
        }

        // ── todo_add ────────────────────────────────────────────────────
        // Phase 4 routes dated voice captures into Inbox (with a
        // dueDate) instead of Orbit's dailyTasks. Rationale per the
        // Phase 4 brief: voice captures unify on the Inbox surface
        // so Apple Reminders mirroring + sync-back has one canonical
        // local home. Pre-Phase-4 behavior was addDailyTask(title,
        // dateStr) — the dueDate keeps the temporal hint.
        case 'todo_add': {
          if (!action.dateStr) {
            throw new Error('To-do is missing a target date.');
          }
          // Phase 4.1: optional `time` (HH:mm) combines with dateStr into an ISO
          // so the Apple Reminder gets a precise due-time pill. Without time we
          // pass the date-only string; the local inbox card renders "Due Mon DD"
          // via formatDueDate. NEX-198: produced via buildReminderDueIso — the
          // shared PRODUCER of the reminder dueDate shape that reminderFireAt
          // consumes, so the two can't drift.
          const dueIso = buildReminderDueIso(action.dateStr, action.time);
          const willMirror = !!mirrorToReminders;
          const localId = appState.addInboxTask(action.title, {
            dueDate: dueIso,
            source: willMirror ? 'apple_reminders' : 'manual',
            status: 'UNPROCESSED',
          });
          if (willMirror && mirrorToReminders) {
            void mirrorToReminders({ type: 'todo_add', title: action.title, dueDate: dueIso })
              .then((result) => resolveMirrorResult(appState, localId, result))
              .catch(() => {
                // Mirror failed: nothing to orphan. Stamp manual if the task
                // still exists (no-op if undone).
                if (!appState.hasInboxTask || appState.hasInboxTask(localId)) {
                  appState.updateInboxTask(localId, { source: 'manual' });
                }
              });
          }
          results.push({
            title: action.title || 'Untitled Action',
            type: action.type,
            status: 'success',
            detail: `Added to Inbox · Due ${action.dateStr}.`,
            // NEX-195: dated voice captures land in Inbox (Phase 4). Undo
            // reads the mirrored reminder's externalId LIVE off the task.
            entityId: localId,
            surface: 'inbox',
          });
          break;
        }

        default: {
          throw new Error(`Unsupported action type: ${(action as ProposedAction).type}`);
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Action failed.';
      results.push({
        title: action.title || 'Untitled Action',
        type: action.type,
        status: 'failed',
        detail: message,
      });
    }
  }

  // Stamp each result with a stable key
  const ledger: LedgerItem[] = results.map((r, i) => ({
    ...r,
    key: `${Date.now()}-${i}`,
  }));

  return { ledger };
}
