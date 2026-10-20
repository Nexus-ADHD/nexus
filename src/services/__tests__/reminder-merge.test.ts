import { describe, it, expect } from 'vitest';
import { mergeReminderPatch } from '../reminder-merge';

describe('mergeReminderPatch — title/notes preservation', () => {
  it('completion toggle preserves title, notes, alarms', () => {
    const existing = {
      id: 'EVENTKIT-1',
      title: 'Call mom',
      notes: 'ask about Mother\'s Day',
      completed: false,
      completionDate: null,
      dueDate: new Date('2026-05-10T09:00:00Z'),
      startDate: new Date('2026-05-10T09:00:00Z'),
      alarms: [{ relativeOffset: -10 }],
      recurrenceRule: null,
      location: 'Home',
      url: null,
      timeZone: 'America/Los_Angeles',
    };
    const merged = mergeReminderPatch(existing, {
      completed: true,
      completionDate: new Date('2026-05-06T18:00:00Z'),
    });
    expect(merged.title).toBe('Call mom');
    expect(merged.notes).toBe("ask about Mother's Day");
    expect(merged.alarms).toEqual([{ relativeOffset: -10 }]);
    expect(merged.location).toBe('Home');
    expect(merged.timeZone).toBe('America/Los_Angeles');
    expect(merged.completed).toBe(true);
    expect(merged.completionDate).toEqual(new Date('2026-05-06T18:00:00Z'));
    // Existing dueDate stays.
    expect(merged.dueDate).toEqual(new Date('2026-05-10T09:00:00Z'));
  });

  it('un-complete preserves everything and clears completionDate', () => {
    const existing = {
      id: 'EVENTKIT-2',
      title: 'Pick up dry cleaning',
      notes: 'receipt in glove compartment',
      completed: true,
      completionDate: new Date('2026-05-04T12:00:00Z'),
      alarms: [],
    };
    const merged = mergeReminderPatch(existing, {
      completed: false,
      completionDate: null,
    });
    expect(merged.title).toBe('Pick up dry cleaning');
    expect(merged.notes).toBe('receipt in glove compartment');
    expect(merged.completed).toBe(false);
    expect(merged.completionDate).toBeNull();
  });

  it('due-date update preserves title, notes, completion state', () => {
    const existing = {
      id: 'EVENTKIT-3',
      title: 'Submit expenses',
      notes: 'Q1 receipts in Drive',
      completed: false,
      completionDate: null,
      dueDate: null,
      startDate: null,
      alarms: [],
    };
    const newDue = new Date('2026-05-08T17:00:00Z');
    const merged = mergeReminderPatch(existing, {
      dueDate: newDue,
      startDate: newDue,
    });
    expect(merged.title).toBe('Submit expenses');
    expect(merged.notes).toBe('Q1 receipts in Drive');
    expect(merged.completed).toBe(false);
    expect(merged.dueDate).toEqual(newDue);
    expect(merged.startDate).toEqual(newDue);
  });
});

describe('mergeReminderPatch — safe defaults', () => {
  it('fills missing fields on the existing object with safe defaults', () => {
    // Simulates a sparse EventKit response where the binding only
    // populates fields the reminder actually has set. We must NEVER
    // pass `undefined` to updateReminderAsync.
    const sparse = {
      id: 'EVENTKIT-4',
      title: 'Buy bread',
      // notes, alarms, dueDate all absent.
    };
    const merged = mergeReminderPatch(sparse as any, { completed: true });
    expect(merged.title).toBe('Buy bread');
    expect(merged.notes).toBeNull();
    expect(merged.alarms).toEqual([]);
    expect(merged.dueDate).toBeNull();
    expect(merged.startDate).toBeNull();
    expect(merged.recurrenceRule).toBeNull();
    expect(merged.location).toBeNull();
    expect(merged.url).toBeNull();
    expect(merged.timeZone).toBeNull();
    // None of the merged fields should be `undefined` — that would
    // trigger the destructive-write behavior we're guarding against.
    for (const k of Object.keys(merged)) {
      expect(merged[k]).not.toBeUndefined();
    }
  });

  it('explicit null in patch correctly clears the existing value', () => {
    const existing = {
      id: 'EVENTKIT-5',
      title: 'Meeting prep',
      dueDate: new Date('2026-05-08T09:00:00Z'),
      startDate: new Date('2026-05-08T09:00:00Z'),
    };
    const merged = mergeReminderPatch(existing, {
      dueDate: null,
      startDate: null,
    });
    expect(merged.title).toBe('Meeting prep');
    expect(merged.dueDate).toBeNull();
    expect(merged.startDate).toBeNull();
  });
});

describe('mergeReminderPatch — updateReminderDueDate patch shape (Phase 5.3)', () => {
  // These cases mirror exactly what updateReminderDueDate writes
  // through patchReminder. The same merge contract that protects
  // markReminderComplete must also protect the triage Today / This
  // week paths — that was the lingering destructive surface on
  // Phase 5 before 5.3.

  it('triage Today / This week patch ({ dueDate, startDate }) preserves title, notes, alarms', () => {
    const existing = {
      id: 'EVENTKIT-PHASE5-1',
      title: 'Stretch tonight',
      notes: 'Hamstrings, 10 min',
      completed: false,
      completionDate: null,
      dueDate: null,
      startDate: null,
      alarms: [{ relativeOffset: -30 }],
      recurrenceRule: null,
      location: null,
      url: null,
      timeZone: null,
    };
    const newDue = new Date('2026-05-08T17:00:00Z');
    const merged = mergeReminderPatch(existing, {
      dueDate: newDue,
      startDate: newDue,
    });
    expect(merged.title).toBe('Stretch tonight');
    expect(merged.notes).toBe('Hamstrings, 10 min');
    expect(merged.alarms).toEqual([{ relativeOffset: -30 }]);
    expect(merged.completed).toBe(false);
    expect(merged.dueDate).toEqual(newDue);
    expect(merged.startDate).toEqual(newDue);
  });

  it('clearing dueDate to null preserves title and notes', () => {
    const existing = {
      id: 'EVENTKIT-PHASE5-2',
      title: 'Email Sean',
      notes: 'Re: feedback',
      completed: false,
      dueDate: new Date('2026-05-10T09:00:00Z'),
      startDate: new Date('2026-05-10T09:00:00Z'),
    };
    const merged = mergeReminderPatch(existing, {
      dueDate: null,
      startDate: null,
    });
    expect(merged.title).toBe('Email Sean');
    expect(merged.notes).toBe('Re: feedback');
    expect(merged.dueDate).toBeNull();
    expect(merged.startDate).toBeNull();
  });

  it('triage patch leaves every non-due-date field untouched', () => {
    // Strong invariant: patchReminder + mergeReminderPatch must
    // ONLY change the keys present in the patch. Any drift here
    // means the destructive-write surface is back.
    const existing = {
      id: 'EVENTKIT-PHASE5-3',
      title: 'Pay phone bill',
      notes: 'Verizon, due 12th',
      completed: false,
      completionDate: null,
      dueDate: null,
      startDate: null,
      alarms: [],
      recurrenceRule: { frequency: 'monthly' } as any,
      location: 'Home',
      url: 'https://verizon.com',
      timeZone: 'America/Los_Angeles',
    };
    const newDue = new Date('2026-05-12T18:00:00Z');
    const merged = mergeReminderPatch(existing, {
      dueDate: newDue,
      startDate: newDue,
    });
    // Only the two patched keys changed.
    expect(merged.title).toBe('Pay phone bill');
    expect(merged.notes).toBe('Verizon, due 12th');
    expect(merged.completed).toBe(false);
    expect(merged.completionDate).toBeNull();
    expect(merged.alarms).toEqual([]);
    expect(merged.recurrenceRule).toEqual({ frequency: 'monthly' });
    expect(merged.location).toBe('Home');
    expect(merged.url).toBe('https://verizon.com');
    expect(merged.timeZone).toBe('America/Los_Angeles');
    expect(merged.dueDate).toEqual(newDue);
    expect(merged.startDate).toEqual(newDue);
  });
});

describe('mergeReminderPatch — updateReminderTitle patch shape (Phase 6)', () => {
  // updateReminderTitle issues `{ title }` through patchReminder.
  // Same non-destructive contract as updateReminderDueDate — the
  // title change must not collateral-wipe notes / alarms / due
  // dates / completion state.

  it('title-only patch preserves notes, dueDate, alarms, completed', () => {
    const existing = {
      id: 'EVENTKIT-PHASE6-1',
      title: 'Old title',
      notes: 'Important context worth preserving',
      completed: false,
      completionDate: null,
      dueDate: new Date('2026-05-12T17:00:00Z'),
      startDate: new Date('2026-05-12T17:00:00Z'),
      alarms: [{ relativeOffset: -60 }],
      recurrenceRule: null,
      location: null,
      url: null,
      timeZone: null,
    };
    const merged = mergeReminderPatch(existing, { title: 'New title' });
    expect(merged.title).toBe('New title');
    expect(merged.notes).toBe('Important context worth preserving');
    expect(merged.dueDate).toEqual(new Date('2026-05-12T17:00:00Z'));
    expect(merged.startDate).toEqual(new Date('2026-05-12T17:00:00Z'));
    expect(merged.alarms).toEqual([{ relativeOffset: -60 }]);
    expect(merged.completed).toBe(false);
  });

  it('renaming a completed reminder leaves completion state untouched', () => {
    // Edge case: user edits title on an already-completed reminder.
    // The completion state and completionDate must survive.
    const existing = {
      id: 'EVENTKIT-PHASE6-2',
      title: 'Pick up dry cleaning',
      notes: null,
      completed: true,
      completionDate: new Date('2026-05-04T12:00:00Z'),
      alarms: [],
    };
    const merged = mergeReminderPatch(existing, {
      title: 'Pick up dry cleaning (rescheduled)',
    });
    expect(merged.title).toBe('Pick up dry cleaning (rescheduled)');
    expect(merged.completed).toBe(true);
    expect(merged.completionDate).toEqual(new Date('2026-05-04T12:00:00Z'));
  });
});

describe('mergeReminderPatch — does not mutate inputs', () => {
  it('returns a new object; original existing reference is untouched', () => {
    const existing = {
      id: 'EVENTKIT-6',
      title: 'Original',
      notes: 'Original notes',
      completed: false,
    };
    const before = JSON.stringify(existing);
    const merged = mergeReminderPatch(existing, { completed: true });
    expect(merged).not.toBe(existing);
    expect(JSON.stringify(existing)).toBe(before);
    expect(merged.completed).toBe(true);
  });

  it('passes through unknown extra fields on existing (forward-compat)', () => {
    const existing = {
      id: 'EVENTKIT-7',
      title: 'Has weird future field',
      futureField: 'some-ios-27-thing',
    } as any;
    const merged = mergeReminderPatch(existing, { completed: true });
    expect((merged as any).futureField).toBe('some-ios-27-thing');
  });
});
