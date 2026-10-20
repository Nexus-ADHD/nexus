import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  executeProposedActions,
  type ExecutorAppState,
  type CreateAppleRecurringEventFn,
} from '../command-executor';
import type { ProposedAction } from '../command-types';

// NEX-194 (Greptile follow-up): a timed recurring_add with empty days must give
// the local rule AND the Apple Calendar event (initial create + retry payload)
// the SAME defaulted (today-only) days. Otherwise the Apple event's own
// empty→today fallback recomputes "today" at sync/retry time, which can differ
// from the local rule's create-day, desyncing Home and Apple Calendar.

// Freeze the clock so the executor's internal new Date().getDay() and the
// test's expected day come from the SAME fixed instant — no flake if the run
// straddles local midnight. Wed 2026-06-17 12:00 local → getDay() === 3.
const FIXED_NOW = new Date(2026, 5, 17, 12, 0, 0);
const FIXED_DOW = FIXED_NOW.getDay(); // 3 (Wednesday)

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function makeAppState(capture: { ruleDays?: number[] }): ExecutorAppState {
  return {
    pillars: [],
    addInboxTask: vi.fn(() => 'inbox-1'),
    updateInboxTask: vi.fn(),
    addRecurringRule: vi.fn((_title, daysOfWeek) => {
      capture.ruleDays = daysOfWeek;
      return 'rule-1';
    }),
    addRecurringToDo: vi.fn(() => 'todo-1'),
    addDailyTask: vi.fn(),
    setPillars: vi.fn(),
    addPillar: vi.fn(),
    linkRecurringRuleToAppleEvent: vi.fn(),
  };
}

describe('recurring_add Apple-sync day parity (NEX-194)', () => {
  it('passes the same defaulted days to the local rule and the Apple event for empty-days timed habits', async () => {
    const capture: { ruleDays?: number[] } = {};
    const appState = makeAppState(capture);

    let appleDays: number[] | undefined;
    const createRecurringAppleCalendarEvent: CreateAppleRecurringEventFn = vi.fn(
      async (_calendarId, action) => {
        appleDays = action.daysOfWeek;
        return 'apple-event-1';
      },
    );

    const action: ProposedAction = {
      type: 'recurring_add',
      title: 'Evening walk',
      daysOfWeek: [], // empty → executor defaults to today-only
      time: '18:00', // timed → syncs to Apple Calendar
    };

    const { ledger } = await executeProposedActions({
      proposedActions: [action],
      appState,
      ensureWritableCalendar: async () => 'cal-1',
      createCalendarEvent: vi.fn(async () => {}),
      createRecurringAppleCalendarEvent,
    });

    const today = [FIXED_DOW];
    // The local rule got today-only days.
    expect(capture.ruleDays).toEqual(today);
    // The Apple event got the SAME defaulted array (not the raw empty array).
    expect(appleDays).toEqual(today);
    expect(appleDays).toEqual(capture.ruleDays);

    const row = ledger.find((l) => l.type === 'recurring_add');
    expect(row?.entityId).toBe('rule-1');
    expect(row?.surface).toBe('home_today');
  });

  it('stores the defaulted days on the retry payload when the Apple sync fails', async () => {
    const capture: { ruleDays?: number[] } = {};
    const appState = makeAppState(capture);

    // Apple create throws → ledger row is 'partial' and carries actionPayload
    // for the retry path. That payload must hold the SAME defaulted days as the
    // local rule, so a later retry can't recompute a different "today".
    const createRecurringAppleCalendarEvent: CreateAppleRecurringEventFn = vi.fn(
      async () => {
        throw new Error('EventKit down');
      },
    );

    const action: ProposedAction = {
      type: 'recurring_add',
      title: 'Evening walk',
      daysOfWeek: [],
      time: '18:00',
    };

    const { ledger } = await executeProposedActions({
      proposedActions: [action],
      appState,
      ensureWritableCalendar: async () => 'cal-1',
      createCalendarEvent: vi.fn(async () => {}),
      createRecurringAppleCalendarEvent,
    });

    const row = ledger.find((l) => l.type === 'recurring_add');
    expect(row?.status).toBe('partial');
    expect(row?.retryType).toBe('recurring_apple_sync');
    // Retry payload days === local rule days === today-only default.
    expect(row?.actionPayload?.daysOfWeek).toEqual([FIXED_DOW]);
    expect(row?.actionPayload?.daysOfWeek).toEqual(capture.ruleDays);
    expect(row?.entityId).toBe('rule-1');
    expect(row?.surface).toBe('home_today');
  });

  it('preserves explicit days for both the local rule and the Apple event', async () => {
    const capture: { ruleDays?: number[] } = {};
    const appState = makeAppState(capture);

    let appleDays: number[] | undefined;
    const createRecurringAppleCalendarEvent: CreateAppleRecurringEventFn = vi.fn(
      async (_calendarId, action) => {
        appleDays = action.daysOfWeek;
        return 'apple-event-2';
      },
    );

    const action: ProposedAction = {
      type: 'recurring_add',
      title: 'Gym',
      daysOfWeek: [1, 3, 5],
      time: '07:00',
    };

    await executeProposedActions({
      proposedActions: [action],
      appState,
      ensureWritableCalendar: async () => 'cal-1',
      createCalendarEvent: vi.fn(async () => {}),
      createRecurringAppleCalendarEvent,
    });

    expect(capture.ruleDays).toEqual([1, 3, 5]);
    expect(appleDays).toEqual([1, 3, 5]);
  });
});

// NEX-194 (Greptile #135 follow-up): defaulting an ambiguous cadence to
// today-only is allowed (surface-first, §1.5 Law A) but must NOT be silent.
// The confirmation announces the default and how to change it; the result
// carries scheduleDefaulted:true so the UI can offer the one-tap refinement
// (NEX-195). Explicit-days habits must stay clean (no flag, no note).
describe('recurring_add ambiguous-cadence clarification (NEX-194)', () => {
  it('flags an empty-days habit and appends the clarifying note to the detail', async () => {
    const capture: { ruleDays?: number[] } = {};
    const appState = makeAppState(capture);

    const action: ProposedAction = {
      type: 'recurring_add',
      title: 'Meditate',
      daysOfWeek: [], // ambiguous → today-only default, announced not silent
    };

    const { ledger } = await executeProposedActions({
      proposedActions: [action],
      appState,
      ensureWritableCalendar: async () => 'cal-1',
      createCalendarEvent: vi.fn(async () => {}),
      createRecurringAppleCalendarEvent: vi.fn(async () => 'apple-event-3'),
    });

    const row = ledger.find((l) => l.type === 'recurring_add');
    expect(row?.scheduleDefaulted).toBe(true);
    expect(row?.detail).toContain('Set to today for now');
    expect(row?.detail).toContain('change the schedule');
    // The local rule still got today-only days so it surfaces now.
    expect(capture.ruleDays).toEqual([FIXED_DOW]);
  });

  it('does NOT flag or annotate a habit with explicit days', async () => {
    const capture: { ruleDays?: number[] } = {};
    const appState = makeAppState(capture);

    const action: ProposedAction = {
      type: 'recurring_add',
      title: 'Gym',
      daysOfWeek: [1, 3, 5],
    };

    const { ledger } = await executeProposedActions({
      proposedActions: [action],
      appState,
      ensureWritableCalendar: async () => 'cal-1',
      createCalendarEvent: vi.fn(async () => {}),
      createRecurringAppleCalendarEvent: vi.fn(async () => 'apple-event-4'),
    });

    const row = ledger.find((l) => l.type === 'recurring_add');
    expect(row?.scheduleDefaulted).toBeFalsy();
    expect(row?.detail).not.toContain('Set to today for now');
    expect(capture.ruleDays).toEqual([1, 3, 5]);
  });

  // The Apple-sync retry handler (app/(tabs)/index.tsx) re-appends the note on
  // a successful retry by reading entry.scheduleDefaulted. That only works if
  // the PARTIAL (sync-failed) ledger row already carries the flag + note. Guard
  // that precondition here. (Greptile #135.)
  it('carries scheduleDefaulted + note on the partial row when Apple sync fails', async () => {
    const capture: { ruleDays?: number[] } = {};
    const appState = makeAppState(capture);

    const action: ProposedAction = {
      type: 'recurring_add',
      title: 'Evening walk',
      daysOfWeek: [], // ambiguous
      time: '18:00', // timed → attempts Apple sync
    };

    const { ledger } = await executeProposedActions({
      proposedActions: [action],
      appState,
      ensureWritableCalendar: async () => 'cal-1',
      createCalendarEvent: vi.fn(async () => {}),
      createRecurringAppleCalendarEvent: vi.fn(async () => {
        throw new Error('EventKit down');
      }),
    });

    const row = ledger.find((l) => l.type === 'recurring_add');
    expect(row?.status).toBe('partial');
    expect(row?.scheduleDefaulted).toBe(true);
    expect(row?.detail).toContain('Set to today for now');
  });
});
