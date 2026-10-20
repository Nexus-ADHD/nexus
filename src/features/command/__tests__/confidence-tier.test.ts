import { describe, expect, it } from 'vitest';
import {
  resolveCaptureTier,
  hasExplicitTime,
  hasExplicitDate,
  inboxFallback,
} from '../confidence-tier';
import {
  ProposedAction,
  normalizeProposedAction,
  validateProposedAction,
} from '../../../utils/recurrence';

// Fixed clock: Tuesday 2026-06-16, local.
const NOW = new Date(2026, 5, 16, 10, 0, 0);

function action(partial: Partial<ProposedAction> & { type: ProposedAction['type'] }): ProposedAction {
  return normalizeProposedAction({ title: 'Thing', confidence: 'high', ...partial });
}

describe('hasExplicitTime / hasExplicitDate', () => {
  it('detects clock times and time-of-day words', () => {
    expect(hasExplicitTime('call her at 3pm')).toBe(true);
    expect(hasExplicitTime('meeting 14:30')).toBe(true);
    expect(hasExplicitTime('do it tonight')).toBe(true);
    expect(hasExplicitTime('call the dentist')).toBe(false);
  });
  it('detects dates, weekdays and relative days', () => {
    expect(hasExplicitDate('tomorrow')).toBe(true);
    expect(hasExplicitDate('on Friday')).toBe(true);
    expect(hasExplicitDate('this weekend')).toBe(true);
    expect(hasExplicitDate('clean the garage')).toBe(false);
  });
  it('"next Monday" / "next Friday" count as date evidence (weekday alternation)', () => {
    expect(hasExplicitDate('call dentist next Monday')).toBe(true);
    expect(hasExplicitDate('call dentist next Friday')).toBe(true);
  });
});

describe('resolveCaptureTier — high', () => {
  it('a complete habit with days + timesPerDay is high', () => {
    const res = resolveCaptureTier(
      [action({ type: 'recurring_add', title: 'Meditate', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], timesPerDay: 1 })],
      'meditate every day',
      NOW,
    );
    expect(res.tier).toBe('high');
    expect(res.clarification).toBeUndefined();
  });

  it('defaults timesPerDay so a timeless daily habit is high (no time question)', () => {
    const res = resolveCaptureTier(
      [action({ type: 'recurring_add', title: 'Stretch', daysOfWeek: [1, 2, 3, 4, 5] })],
      'stretch on weekdays',
      NOW,
    );
    expect(res.tier).toBe('high');
    expect(res.actions[0].timesPerDay).toBe(1);
  });

  it('vague-but-captured intent rides the high Inbox path, never low', () => {
    const res = resolveCaptureTier(
      [action({ type: 'inbox_add', title: 'Feeling scattered', confidence: 'medium' })],
      'feeling scattered today',
      NOW,
    );
    expect(res.tier).toBe('high');
  });

  it('a todo with an explicit, user-stated date is high', () => {
    const res = resolveCaptureTier(
      [action({ type: 'todo_add', title: 'Call dentist', dateStr: '2026-06-17' })],
      'call the dentist tomorrow',
      NOW,
    );
    expect(res.tier).toBe('high');
  });

  it('a calendar event with an explicit date AND time is high', () => {
    const res = resolveCaptureTier(
      [action({ type: 'calendar_add', title: 'Standup', startISO: '2026-06-16T09:00:00', endISO: '2026-06-16T10:00:00' })],
      'add standup today at 9am to my calendar',
      NOW,
    );
    expect(res.tier).toBe('high');
  });
});

describe('resolveCaptureTier — medium (one scoped question)', () => {
  it('habit missing days → Which days? with three presets', () => {
    const res = resolveCaptureTier(
      [action({ type: 'recurring_add', title: 'Workout', daysOfWeek: [] })],
      'start a workout habit',
      NOW,
    );
    expect(res.tier).toBe('medium');
    expect(res.clarification?.fieldKey).toBe('daysOfWeek');
    expect(res.clarification?.chips.map((c) => c.label)).toEqual(['Every day', 'Weekdays', 'Weekends']);
    expect(res.clarification?.targetIndices).toEqual([0]);
  });

  it('todo with a model-GUESSED date (no transcript evidence) → When?', () => {
    const res = resolveCaptureTier(
      [action({ type: 'todo_add', title: 'Call dentist', dateStr: '2026-06-16' })],
      'call the dentist', // no date said
      NOW,
    );
    expect(res.tier).toBe('medium');
    expect(res.clarification?.fieldKey).toBe('date');
    expect(res.clarification?.chips[0]).toEqual({ label: 'Today', patch: { dateStr: '2026-06-16' } });
    expect(res.clarification?.chips[1].patch.dateStr).toBe('2026-06-17');
  });

  it('calendar with a date but no stated time → captured to Inbox (never a chip-guessed EventKit write)', () => {
    const res = resolveCaptureTier(
      [action({ type: 'calendar_add', title: 'Dentist', startISO: '2026-06-17T09:00:00', endISO: '2026-06-17T10:00:00' })],
      'dentist tomorrow', // date but no time
      NOW,
    );
    expect(res.tier).toBe('high');
    expect(res.actions[0].type).toBe('inbox_add');
    expect(res.clarification).toBeUndefined();
  });

  it('two habits both missing days → ONE question, patches BOTH', () => {
    const res = resolveCaptureTier(
      [
        action({ type: 'recurring_add', title: 'Workout', daysOfWeek: [] }),
        action({ type: 'recurring_add', title: 'Meditate', daysOfWeek: [] }),
      ],
      'start a workout habit and a meditation habit',
      NOW,
    );
    expect(res.tier).toBe('medium');
    expect(res.clarification?.targetIndices).toEqual([0, 1]);
  });
});

describe('resolveCaptureTier — compound, one-question-max', () => {
  it('two complete actions execute together as high', () => {
    const res = resolveCaptureTier(
      [
        action({ type: 'recurring_add', title: 'Meditate', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], timesPerDay: 1 }),
        action({ type: 'inbox_add', title: 'Buy milk' }),
      ],
      'meditate every day and remember to buy milk',
      NOW,
    );
    expect(res.tier).toBe('high');
  });

  it('different missing fields (days + date) → ONE clarification; the other is captured to Inbox, never a habit downgrade', () => {
    const res = resolveCaptureTier(
      [
        action({ type: 'recurring_add', title: 'Workout', daysOfWeek: [] }), // needs days
        action({ type: 'todo_add', title: 'Call dentist', dateStr: '2026-06-16' }), // guessed date
      ],
      'start a workout habit and call the dentist',
      NOW,
    );
    expect(res.tier).toBe('medium');
    // days wins priority → habit is the question target, never downgraded.
    expect(res.clarification?.fieldKey).toBe('daysOfWeek');
    expect(res.clarification?.targetIndices).toEqual([0]);
    expect(res.actions[0].type).toBe('recurring_add');
    // the unresolved todo is captured to Inbox, visibly.
    expect(res.actions[1].type).toBe('inbox_add');
    expect(res.actions[1].explanation).toMatch(/Inbox/i);
  });
});

describe('resolveCaptureTier — mixed-batch noise', () => {
  it('a confident item + a low-confidence malformed inbox fallback → high; only the confident one executes, the noise is dropped', () => {
    const res = resolveCaptureTier(
      [
        action({ type: 'inbox_add', title: 'Buy milk', confidence: 'high' }),
        action({ type: 'inbox_add', title: 'garbled', confidence: 'low', nextAction: 'Clarify intent' }),
      ],
      'buy milk and ...garbled...',
      NOW,
    );
    expect(res.tier).toBe('high');
    expect(res.actions).toHaveLength(1);
    expect(res.actions[0].title).toBe('Buy milk');
  });

  it('a confident item + a low-confidence calendar (downgraded to a visible Inbox capture) keeps BOTH — the downgrade is never dropped', () => {
    const res = resolveCaptureTier(
      [
        action({ type: 'inbox_add', title: 'Buy milk', confidence: 'high' }),
        // low calendar → prepareAction converts to a visible Inbox capture (nextAction 'Schedule from Inbox')
        action({ type: 'calendar_add', title: 'Dentist', confidence: 'low', startISO: '2026-06-16T09:00:00', endISO: '2026-06-16T10:00:00' }),
      ],
      'buy milk and maybe a dentist thing at 9am today',
      NOW,
    );
    expect(res.tier).toBe('high');
    expect(res.actions).toHaveLength(2);
    const dentist = res.actions.find((a) => a.title === 'Dentist');
    expect(dentist?.type).toBe('inbox_add'); // visible Inbox capture, not dropped
  });

  it('a confident item + a low-confidence habit (recurring_add, days set) does NOT create a rule → captured to Inbox', () => {
    const res = resolveCaptureTier(
      [
        action({ type: 'inbox_add', title: 'Buy milk', confidence: 'high' }),
        action({ type: 'recurring_add', title: 'Maybe meditate', confidence: 'low', daysOfWeek: [1], timesPerDay: 1 }),
      ],
      'buy milk and maybe meditate on mondays or something',
      NOW,
    );
    expect(res.tier).toBe('high');
    const habit = res.actions.find((a) => a.title === 'Maybe meditate');
    expect(habit?.type).toBe('inbox_add'); // never silently created as a recurring rule
  });
});

describe('resolveCaptureTier — low', () => {
  it('empty action list is low', () => {
    expect(resolveCaptureTier([], 'garble', NOW).tier).toBe('low');
  });
  it('a low-confidence inbox fallback (the coerceAction [null] case) is low, not silently saved', () => {
    const res = resolveCaptureTier(
      [action({ type: 'inbox_add', title: 'garbled words', confidence: 'low', nextAction: 'Clarify intent' })],
      'garbled words',
      NOW,
    );
    expect(res.tier).toBe('low');
  });
});

describe('resolveCaptureTier — calendar date-evidence safety (P1)', () => {
  it('time stated but NO date → captured to Inbox; the model-guessed startISO date never reaches EventKit', () => {
    const res = resolveCaptureTier(
      // model guessed a future startISO date the user never said
      [action({ type: 'calendar_add', title: 'Dentist', startISO: '2026-07-20T09:00:00', endISO: '2026-07-20T10:00:00' })],
      'add dentist at 9am to my calendar', // time yes, date no
      NOW,
    );
    expect(res.tier).toBe('high');
    expect(res.actions[0].type).toBe('inbox_add'); // not a calendar write
    expect(res.clarification).toBeUndefined();
  });
  it('both date AND time stated → high calendar write (fully user-specified)', () => {
    const res = resolveCaptureTier(
      [action({ type: 'calendar_add', title: 'Standup', startISO: '2026-06-17T09:00:00', endISO: '2026-06-17T10:00:00' })],
      'add standup tomorrow at 9am to my calendar',
      NOW,
    );
    expect(res.tier).toBe('high');
    expect(res.actions[0].type).toBe('calendar_add'); // direct write preserved
  });
  it('COMPOUND: a second calendar cannot borrow a sibling’s time → all calendars go to Inbox (per-action evidence is unattributable)', () => {
    const res = resolveCaptureTier(
      [
        action({ type: 'calendar_add', title: 'Standup', startISO: '2026-06-17T09:00:00', endISO: '2026-06-17T10:00:00' }),
        // model guessed 9am for the dentist from the sibling's "9am"
        action({ type: 'calendar_add', title: 'Dentist', startISO: '2026-06-17T09:00:00', endISO: '2026-06-17T10:00:00' }),
      ],
      'add standup tomorrow at 9am and a dentist appointment',
      NOW,
    );
    expect(res.actions.every((a) => a.type === 'inbox_add')).toBe(true);
    expect(res.clarification).toBeUndefined();
  });
  it('a LOW-confidence calendar with date+time still does NOT auto-write → low tier (retry)', () => {
    const res = resolveCaptureTier(
      [action({ type: 'calendar_add', title: 'Standup', confidence: 'low', startISO: '2026-06-16T09:00:00', endISO: '2026-06-16T10:00:00' })],
      'something about a standup today at 9am maybe',
      NOW,
    );
    expect(res.tier).toBe('low');
  });
  it('UNDEFINED confidence does NOT count as high → calendar captured to Inbox, not written to EventKit', () => {
    const res = resolveCaptureTier(
      [action({ type: 'calendar_add', title: 'Standup', confidence: undefined, startISO: '2026-06-16T09:00:00', endISO: '2026-06-16T10:00:00' })],
      'add standup today at 9am to my calendar',
      NOW,
    );
    expect(res.actions[0].type).toBe('inbox_add');
    expect(res.clarification).toBeUndefined();
  });
  it('a todo with date evidence but non-high confidence confirms via When? chips, never a silent due-date write', () => {
    const res = resolveCaptureTier(
      [action({ type: 'todo_add', title: 'Call dentist', confidence: 'medium', dateStr: '2026-06-17' })],
      'call the dentist tomorrow',
      NOW,
    );
    expect(res.tier).toBe('medium');
    expect(res.clarification?.fieldKey).toBe('date');
  });
});

describe('resolveCaptureTier — interval-only chore (P2)', () => {
  it('"every other day" (interval>=2, no days) is captured to Inbox — never asked Which days? or corrupted to all-week', () => {
    const res = resolveCaptureTier(
      [action({ type: 'recurring_todo_add', title: 'Water plants', interval: 2, daysOfWeek: [] })],
      'water the plants every other day',
      NOW,
    );
    expect(res.tier).toBe('high');
    expect(res.actions[0].type).toBe('inbox_add');
    expect(res.actions[0].explanation).toMatch(/Inbox/i);
    expect(res.clarification).toBeUndefined();
  });
  it('a weekly chore with no day still asks Which days?', () => {
    const res = resolveCaptureTier(
      [action({ type: 'recurring_todo_add', title: 'Take out trash', daysOfWeek: [] })],
      'take out the trash',
      NOW,
    );
    expect(res.tier).toBe('medium');
    expect(res.clarification?.fieldKey).toBe('daysOfWeek');
  });
});

describe('chip patches resolve validation', () => {
  it('applying the Weekdays chip makes a dayless habit valid', () => {
    const res = resolveCaptureTier(
      [action({ type: 'recurring_add', title: 'Workout', daysOfWeek: [] })],
      'start a workout habit',
      NOW,
    );
    const chip = res.clarification!.chips.find((c) => c.label === 'Weekdays')!;
    const patched = normalizeProposedAction({ ...res.actions[0], ...chip.patch });
    expect(validateProposedAction(patched).valid).toBe(true);
  });

  it('applying a When? date chip makes a dateless todo valid', () => {
    const res = resolveCaptureTier(
      [action({ type: 'todo_add', title: 'Call dentist' })],
      'call the dentist',
      NOW,
    );
    const chip = res.clarification!.chips.find((c) => c.label === 'Tomorrow')!;
    const patched = normalizeProposedAction({ ...res.actions[0], ...chip.patch });
    expect(validateProposedAction(patched).valid).toBe(true);
  });
});

describe('inboxFallback', () => {
  it('coerces any action to a visible inbox capture preserving the title', () => {
    const fb = inboxFallback(action({ type: 'calendar_add', title: 'Mystery block' }));
    expect(fb.type).toBe('inbox_add');
    expect(fb.title).toBe('Mystery block');
    expect(fb.explanation).toMatch(/Inbox/i);
  });

  it('uses field-accurate copy: a date-needing downgrade says "date"', () => {
    const fb = inboxFallback(action({ type: 'todo_add', title: 'Call mom' }), 'date');
    expect(fb.explanation).toMatch(/date/i);
  });

  it('two under-specified calendar events → both captured to Inbox, no calendar write, no chip', () => {
    const res = resolveCaptureTier(
      [
        action({ type: 'calendar_add', title: 'Standup', startISO: '2026-06-16T09:00:00', endISO: '2026-06-16T10:00:00' }),
        action({ type: 'calendar_add', title: 'Lunch', startISO: '2026-06-16T12:00:00', endISO: '2026-06-16T13:00:00' }),
      ],
      'add standup and lunch to my calendar', // no times said
      NOW,
    );
    expect(res.tier).toBe('high');
    expect(res.actions[0].type).toBe('inbox_add');
    expect(res.actions[1].type).toBe('inbox_add');
    expect(res.clarification).toBeUndefined();
  });
});

// NEX-302: the normalized title no longer carries the schedule words the old
// verbatim title incidentally kept, so an Inbox downgrade backfills what the
// user actually said into the description.

describe('toInbox downgrades carry the raw transcript (NEX-302)', () => {
  it('a downgraded calendar_add keeps the transcript in description', () => {
    const res = resolveCaptureTier(
      [
        action({
          type: 'calendar_add',
          title: 'Podcast',
          startISO: '2026-06-16T17:00:00',
          endISO: '2026-06-16T18:00:00',
        }),
      ],
      'add podcast sometime soon', // no explicit time → calendar safety downgrade
      NOW,
    );
    expect(res.actions[0].type).toBe('inbox_add');
    expect(res.actions[0].description).toBe('add podcast sometime soon');
  });

  it('an AI-provided description is preserved over the transcript backfill', () => {
    const res = resolveCaptureTier(
      [
        action({
          type: 'calendar_add',
          title: 'Podcast',
          description: 'Weekly episode prep',
          startISO: '2026-06-16T17:00:00',
          endISO: '2026-06-16T18:00:00',
        }),
      ],
      'add podcast sometime soon',
      NOW,
    );
    expect(res.actions[0].type).toBe('inbox_add');
    expect(res.actions[0].description).toBe('Weekly episode prep');
  });
});
