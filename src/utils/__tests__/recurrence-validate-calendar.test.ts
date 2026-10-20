import { describe, expect, it } from 'vitest';
import { validateProposedAction, type ProposedAction } from '../recurrence';

// calendar_add gains an OPTIONAL nested `recurrence` (a repeating Apple Calendar
// event). Absent → one-off, unchanged. Present → validated: frequency must be
// daily|weekly; interval (if given) an integer ≥1; daysOfWeek (if given) all 0–6.
// The start/end requirements are unchanged in every case.

const base = (recurrence?: ProposedAction['recurrence']): ProposedAction => ({
  type: 'calendar_add',
  title: 'Workout',
  startISO: '2026-07-05T10:00:00',
  endISO: '2026-07-05T11:00:00',
  recurrence,
});

describe('validateProposedAction — calendar_add recurrence', () => {
  it('ACCEPTS a one-off calendar_add (no recurrence)', () => {
    const result = validateProposedAction(base());
    expect(result.valid).toBe(true);
  });

  it('ACCEPTS a weekly recurrence with valid days', () => {
    const result = validateProposedAction(
      base({ frequency: 'weekly', daysOfWeek: [0], interval: 1 })
    );
    expect(result.valid).toBe(true);
  });

  it('ACCEPTS a daily recurrence', () => {
    const result = validateProposedAction(base({ frequency: 'daily' }));
    expect(result.valid).toBe(true);
  });

  it('REJECTS an unsupported frequency (monthly)', () => {
    const result = validateProposedAction(
      // @ts-expect-error — exercising an invalid frequency the AI must not emit
      base({ frequency: 'monthly', daysOfWeek: [0] })
    );
    expect(result.valid).toBe(false);
  });

  it('REJECTS an out-of-range day', () => {
    const result = validateProposedAction(base({ frequency: 'weekly', daysOfWeek: [9] }));
    expect(result.valid).toBe(false);
  });

  it('REJECTS a weekly recurrence with no daysOfWeek (would repeat on startDate weekday)', () => {
    const result = validateProposedAction(base({ frequency: 'weekly' }));
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Weekly recurrence requires at least one day in daysOfWeek.');
  });

  it('REJECTS a weekly recurrence with an empty daysOfWeek array', () => {
    const result = validateProposedAction(base({ frequency: 'weekly', daysOfWeek: [] }));
    expect(result.valid).toBe(false);
  });

  it('ACCEPTS a daily recurrence WITHOUT daysOfWeek (days not required for daily)', () => {
    const result = validateProposedAction(base({ frequency: 'daily' }));
    expect(result.valid).toBe(true);
  });

  it('REJECTS an interval below 1', () => {
    const result = validateProposedAction(
      base({ frequency: 'weekly', daysOfWeek: [0], interval: 0 })
    );
    expect(result.valid).toBe(false);
  });

  it('still ENFORCES start/end even with a valid recurrence', () => {
    const action: ProposedAction = {
      type: 'calendar_add',
      title: 'Workout',
      startISO: '2026-07-05T11:00:00',
      endISO: '2026-07-05T10:00:00', // end before start
      recurrence: { frequency: 'weekly', daysOfWeek: [0] },
    };
    const result = validateProposedAction(action);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('End time must be after start time.');
  });

  it('still requires startISO/endISO when recurrence is present', () => {
    const action: ProposedAction = {
      type: 'calendar_add',
      title: 'Workout',
      recurrence: { frequency: 'weekly', daysOfWeek: [0] },
    };
    const result = validateProposedAction(action);
    expect(result.valid).toBe(false);
    expect(result.missingFields).toContain('startISO');
    expect(result.missingFields).toContain('endISO');
  });
});
