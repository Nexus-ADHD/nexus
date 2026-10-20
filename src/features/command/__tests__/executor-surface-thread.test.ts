import { describe, expect, it, vi } from 'vitest';
import { executeProposedActions, type ExecutorAppState } from '../command-executor';
import type { ProposedAction } from '../command-types';

// NEX-195: every create path must thread `entityId` + `surface` (and, for
// Align, `category`) onto its ledger row so the location-bearing confirmation
// can name where the item landed and offer one-tap undo/jump. `calendar_add`
// is jump-only — surface set, NO entityId (a raw Apple event has no Nexus
// entity to undo). These assertions guard the wiring the location-line copy
// reads; the copy mapping itself is covered in confirmation-copy.test.ts.

function makeAppState(): ExecutorAppState {
  return {
    pillars: [],
    addInboxTask: vi.fn(() => 'inbox-1'),
    updateInboxTask: vi.fn(),
    addRecurringRule: vi.fn(() => 'rule-1'),
    addRecurringToDo: vi.fn(() => 'todo-1'),
    addDailyTask: vi.fn(),
    setPillars: vi.fn(),
    addPillar: vi.fn(),
    linkRecurringRuleToAppleEvent: vi.fn(),
  };
}

// Microtask + macrotask flush so fire-and-forget mirror `.then` callbacks run.
const flush = () => new Promise((r) => setTimeout(r, 0));

function run(action: ProposedAction) {
  return executeProposedActions({
    proposedActions: [action],
    appState: makeAppState(),
    ensureWritableCalendar: async () => 'cal-1',
    createCalendarEvent: vi.fn(async () => {}),
    createRecurringAppleCalendarEvent: vi.fn(async () => 'apple-event-1'),
  });
}

describe('NEX-195 ledger surface threading', () => {
  it('inbox_add → surface inbox, entityId = new task id', async () => {
    const { ledger } = await run({ type: 'inbox_add', title: 'Call the dentist' });
    expect(ledger[0].surface).toBe('inbox');
    expect(ledger[0].entityId).toBe('inbox-1');
  });

  it('todo_add (dated) → surface inbox, entityId = new task id', async () => {
    const { ledger } = await run({ type: 'todo_add', title: 'File taxes', dateStr: '2026-06-20' });
    expect(ledger[0].surface).toBe('inbox');
    expect(ledger[0].entityId).toBe('inbox-1');
  });

  it('align → surface align, entityId set, category threaded (not lost to the Business default)', async () => {
    const { ledger } = await run({
      type: 'align',
      title: 'I am someone who ships',
      // category isn't on ProposedAction's typed shape; the executor reads it
      // defensively off the action, same as production.
      ...({ category: 'VISION' } as Record<string, unknown>),
    } as ProposedAction);
    expect(ledger[0].surface).toBe('align');
    expect(ledger[0].entityId).toBeTruthy();
    expect(ledger[0].category).toBe('VISION');
  });

  it('recurring_todo_add → surface orbit, entityId = new rule id', async () => {
    const { ledger } = await run({ type: 'recurring_todo_add', title: 'Water plants', daysOfWeek: [1] });
    expect(ledger[0].surface).toBe('orbit');
    expect(ledger[0].entityId).toBe('todo-1');
  });

  it('calendar_add → surface calendar, NO entityId (jump-only, never undo)', async () => {
    const { ledger } = await run({
      type: 'calendar_add',
      title: 'Dentist',
      startISO: '2026-06-20T15:00:00',
      endISO: '2026-06-20T16:00:00',
    });
    expect(ledger[0].surface).toBe('calendar');
    expect(ledger[0].entityId).toBeUndefined();
  });
});

// ── Greptile 2/5 follow-up fixes ─────────────────────────────────────────────

describe('NEX-195 align data-loss fix (Greptile P1)', () => {
  it('two align actions in one proposal both persist (functional addPillar, not stale snapshot)', async () => {
    // Real pillar list + a functional addPillar that prepends against CURRENT
    // state — the production wiring. The old setPillars-from-snapshot path lost
    // the first pillar.
    const pillars: any[] = [{ id: 'existing', title: 'Existing' }];
    const appState: ExecutorAppState = {
      pillars,
      addInboxTask: vi.fn(() => 'inbox-1'),
      updateInboxTask: vi.fn(),
      addRecurringRule: vi.fn(() => 'rule-1'),
      addRecurringToDo: vi.fn(() => 'todo-1'),
      addDailyTask: vi.fn(),
      setPillars: vi.fn((next: unknown[]) => {
        pillars.length = 0;
        pillars.push(...(next as any[]));
      }),
      addPillar: vi.fn((p: unknown) => {
        pillars.unshift(p);
      }),
      linkRecurringRuleToAppleEvent: vi.fn(),
    };

    await executeProposedActions({
      proposedActions: [
        { type: 'align', title: 'First new pillar', ...({ category: 'BUSINESS' } as any) } as ProposedAction,
        { type: 'align', title: 'Second new pillar', ...({ category: 'VISION' } as any) } as ProposedAction,
      ],
      appState,
      ensureWritableCalendar: async () => 'cal-1',
      createCalendarEvent: vi.fn(async () => {}),
      createRecurringAppleCalendarEvent: vi.fn(async () => 'apple-event-1'),
    });

    const titles = pillars.map((p) => p.title);
    expect(titles).toContain('First new pillar');
    expect(titles).toContain('Second new pillar');
    expect(titles).toContain('Existing');
    expect(appState.setPillars).not.toHaveBeenCalled();
  });
});

describe('NEX-195 orphaned-reminder race fix (Greptile P1)', () => {
  it('drops the just-created reminder when the task was undone before the mirror resolved', async () => {
    const deleteMirroredReminder = vi.fn();
    const updateInboxTask = vi.fn();
    const appState: ExecutorAppState = {
      pillars: [],
      addInboxTask: vi.fn(() => 'inbox-1'),
      updateInboxTask,
      addRecurringRule: vi.fn(() => 'rule-1'),
      addRecurringToDo: vi.fn(() => 'todo-1'),
      addDailyTask: vi.fn(),
      setPillars: vi.fn(),
      addPillar: vi.fn(),
      // Simulate UNDO already removed the local task before the mirror resolved.
      hasInboxTask: vi.fn(() => false),
      deleteMirroredReminder,
      linkRecurringRuleToAppleEvent: vi.fn(),
    };

    await executeProposedActions({
      proposedActions: [{ type: 'inbox_add', title: 'Call mom' }],
      appState,
      ensureWritableCalendar: async () => 'cal-1',
      createCalendarEvent: vi.fn(async () => {}),
      createRecurringAppleCalendarEvent: vi.fn(async () => 'apple-event-1'),
      mirrorToReminders: vi.fn(async () => ({ externalId: 'apple-reminder-1' })),
    });
    await flush();

    // The orphan reminder is deleted; the dead row is NOT stamped.
    expect(deleteMirroredReminder).toHaveBeenCalledWith('apple-reminder-1');
    expect(updateInboxTask).not.toHaveBeenCalledWith('inbox-1', expect.objectContaining({ externalId: 'apple-reminder-1' }));
  });

  it('stamps externalId normally when the task still exists', async () => {
    const updateInboxTask = vi.fn();
    const deleteMirroredReminder = vi.fn();
    const appState: ExecutorAppState = {
      pillars: [],
      addInboxTask: vi.fn(() => 'inbox-1'),
      updateInboxTask,
      addRecurringRule: vi.fn(() => 'rule-1'),
      addRecurringToDo: vi.fn(() => 'todo-1'),
      addDailyTask: vi.fn(),
      setPillars: vi.fn(),
      addPillar: vi.fn(),
      hasInboxTask: vi.fn(() => true),
      deleteMirroredReminder,
      linkRecurringRuleToAppleEvent: vi.fn(),
    };

    await executeProposedActions({
      proposedActions: [{ type: 'inbox_add', title: 'Call mom' }],
      appState,
      ensureWritableCalendar: async () => 'cal-1',
      createCalendarEvent: vi.fn(async () => {}),
      createRecurringAppleCalendarEvent: vi.fn(async () => 'apple-event-1'),
      mirrorToReminders: vi.fn(async () => ({ externalId: 'apple-reminder-1' })),
    });
    await flush();

    expect(updateInboxTask).toHaveBeenCalledWith('inbox-1', { source: 'apple_reminders', externalId: 'apple-reminder-1' });
    expect(deleteMirroredReminder).not.toHaveBeenCalled();
  });
});
