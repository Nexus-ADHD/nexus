import { describe, expect, it } from 'vitest';
import { coerceAction, buildTranscriptInboxAction } from '../command-parser';

describe('buildTranscriptInboxAction — Law A verbatim save', () => {
  it('captures the full transcript as a high-confidence inbox_add', () => {
    const a = buildTranscriptInboxAction('call the mortgage company and the city');
    expect(a.type).toBe('inbox_add');
    expect(a.title).toBe('call the mortgage company and the city');
    expect(a.confidence).toBe('high');
  });

  it('keeps the full words (caps at 200, not fallbackTitle 60) so long captures survive', () => {
    const long = 'a'.repeat(250);
    const a = buildTranscriptInboxAction(long);
    expect(a.title.length).toBe(200);
    expect(a.title.endsWith('...')).toBe(true);
    // A 70-char transcript is preserved whole — fallbackTitle would have cut it.
    const mid = 'b'.repeat(70);
    expect(buildTranscriptInboxAction(mid).title).toBe(mid);
  });

  it('trims and never emits scheduling fields', () => {
    const a = buildTranscriptInboxAction('  spray the wash deck  ');
    expect(a.title).toBe('spray the wash deck');
    expect((a as any).dateStr).toBeUndefined();
    expect((a as any).time).toBeUndefined();
  });
});

// coerceAction rebuilds the AI's untrusted JSON into a typed ProposedAction via a
// strict field allowlist. A calendar_add's nested `recurrence` (and a
// recurring_todo_add's top-level `interval`) MUST be forwarded — without them a
// correct recurring action from the AI was silently collapsed to a one-off /
// weekly downstream (the executor and writer never saw the field).

describe('coerceAction — recurrence + interval forwarding', () => {
  it('forwards a weekly calendar_add recurrence object', () => {
    const a = coerceAction(
      {
        type: 'calendar_add',
        title: 'Workout',
        startISO: '2026-07-05T10:00:00',
        endISO: '2026-07-05T11:00:00',
        recurrence: { frequency: 'weekly', daysOfWeek: [0], interval: 1 },
        confidence: 'high',
      },
      'schedule a workout every Sunday at 10am'
    );
    expect(a.type).toBe('calendar_add');
    expect(a.recurrence).toEqual({ frequency: 'weekly', daysOfWeek: [0], interval: 1 });
  });

  it('forwards a daily recurrence (no days)', () => {
    const a = coerceAction(
      {
        type: 'calendar_add',
        title: 'Check-in',
        startISO: '2026-07-05T22:00:00',
        endISO: '2026-07-05T22:20:00',
        recurrence: { frequency: 'daily', interval: 1 },
        confidence: 'high',
      },
      'add a daily check-in at 10pm'
    );
    expect(a.recurrence).toEqual({ frequency: 'daily', interval: 1 });
  });

  it('preserves an unsupported frequency so validation can reject it (not coerced away)', () => {
    const a = coerceAction(
      {
        type: 'calendar_add',
        title: 'Thing',
        startISO: '2026-07-05T10:00:00',
        endISO: '2026-07-05T11:00:00',
        recurrence: { frequency: 'monthly' },
        confidence: 'high',
      },
      'every month'
    );
    expect(a.recurrence?.frequency).toBe('monthly');
  });

  it('sanitizes out-of-range days via normalization', () => {
    const a = coerceAction(
      {
        type: 'calendar_add',
        title: 'Thing',
        startISO: '2026-07-05T10:00:00',
        endISO: '2026-07-05T11:00:00',
        recurrence: { frequency: 'weekly', daysOfWeek: [0, 9, 3] },
        confidence: 'high',
      },
      'x'
    );
    expect(a.recurrence?.daysOfWeek).toEqual([0, 3]);
  });

  it('leaves recurrence undefined when absent or malformed', () => {
    const oneOff = coerceAction(
      { type: 'calendar_add', title: 'Dentist', startISO: '2026-07-05T14:00:00', endISO: '2026-07-05T15:00:00' },
      'dentist tomorrow at 2pm'
    );
    expect(oneOff.recurrence).toBeUndefined();
    const bad = coerceAction(
      { type: 'calendar_add', title: 'X', recurrence: 'weekly' },
      'x'
    );
    expect(bad.recurrence).toBeUndefined();
  });

  it('forwards a recurring_todo_add interval', () => {
    const a = coerceAction(
      { type: 'recurring_todo_add', title: 'Call mom', daysOfWeek: [2], interval: 2, confidence: 'high' },
      'call mom every other tuesday'
    );
    expect(a.interval).toBe(2);
  });
});

// NEX-302: coerceAction enforces prompt Rule 16 deterministically — an AI title
// that echoes the user's request phrasing verbatim is normalized before it can
// become a calendar event / item title.

describe('coerceAction — NEX-302 title normalization', () => {
  it('strips verbatim framing from a calendar_add title (the shipped bug)', () => {
    const a = coerceAction(
      {
        type: 'calendar_add',
        title: 'Can you add podcast at 5 PM today?',
        startISO: '2026-07-14T17:00:00',
        endISO: '2026-07-14T18:00:00',
        confidence: 'high',
      },
      'Can you add podcast to my calendar at 5 pm?'
    );
    expect(a.title).toBe('Podcast');
  });

  it('strips a cadence tail from a recurring_add title (schedule carried in fields)', () => {
    const a = coerceAction(
      {
        type: 'recurring_add',
        title: 'Meditate every morning',
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        preferredTimeBlock: 'morning',
        confidence: 'high',
      },
      'meditate every morning'
    );
    expect(a.title).toBe('Meditate');
  });

  it('leaves an unscheduled inbox_add title intact (its time words are information)', () => {
    const a = coerceAction(
      { type: 'inbox_add', title: 'Podcast at 5 pm', confidence: 'medium' },
      'podcast at 5 pm maybe'
    );
    expect(a.title).toBe('Podcast at 5 pm');
  });

  it('keeps a mid-title clock on a dated todo_add', () => {
    const a = coerceAction(
      {
        type: 'todo_add',
        title: 'Call about the 3 PM meeting',
        dateStr: '2026-07-15',
        confidence: 'high',
      },
      'call about the 3 PM meeting tomorrow'
    );
    expect(a.title).toBe('Call about the 3 PM meeting');
  });

  it('a DROPPED schedule field is not schedule evidence (title keeps its words)', () => {
    const a = coerceAction(
      {
        type: 'recurring_add',
        title: 'Journal every evening',
        preferredTimeBlock: 'whenever', // off-spec → coercion drops it
        confidence: 'high',
      },
      'journal every evening'
    );
    expect(a.preferredTimeBlock).toBeUndefined();
    expect(a.title).toBe('Journal every evening');
  });

  it('an unsupported AI type falls back to inbox_add with its schedule words intact', () => {
    const a = coerceAction(
      {
        type: 'calendar', // not in ALLOWED_TYPES → inbox_add fallback
        title: 'Podcast at 5pm',
        startISO: '2026-07-14T17:00:00',
        endISO: '2026-07-14T18:00:00',
        confidence: 'high',
      },
      'add podcast at 5pm'
    );
    expect(a.type).toBe('inbox_add');
    expect(a.title).toBe('Podcast at 5pm');
  });

  it('a frequency-less recurrence object is not schedule evidence either', () => {
    const a = coerceAction(
      { type: 'todo_add', title: 'Standup notes at 9am', recurrence: {}, confidence: 'high' },
      'standup notes at 9am'
    );
    expect(a.recurrence).toBeUndefined();
    expect(a.title).toBe('Standup notes at 9am');
  });

  it('normalizes the raw-text fallback when the AI omitted the title', () => {
    const a = coerceAction(
      {
        type: 'calendar_add',
        startISO: '2026-07-14T17:00:00',
        endISO: '2026-07-14T18:00:00',
        confidence: 'high',
      },
      'can you add podcast to my calendar at 5 pm'
    );
    expect(a.title).toBe('Podcast');
  });
});
