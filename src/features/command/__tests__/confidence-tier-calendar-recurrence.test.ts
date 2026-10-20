import { describe, expect, it } from 'vitest';
import { resolveCaptureTier, hasExplicitRecurrence } from '../confidence-tier';
import { normalizeProposedAction, type ProposedAction } from '../../../utils/recurrence';

// A RECURRING calendar_add's schedule evidence is its CADENCE, not a one-off date.
// The pre-existing gate required hasExplicitDate(raw), which matches named
// weekdays but NOT "daily"/"every day"/"every weekday" — so timed daily/weekday
// recurrences were wrongly downgraded to Inbox. The gate now accepts a recurring
// cadence in the transcript as the schedule for a recurring calendar_add.

const NOW = new Date(2026, 5, 16, 10, 0, 0);

function calendarAction(
  partial: Partial<ProposedAction> = {}
): ProposedAction {
  return normalizeProposedAction({
    type: 'calendar_add',
    title: 'Workout',
    startISO: '2026-07-05T10:00:00',
    endISO: '2026-07-05T11:00:00',
    confidence: 'high',
    ...partial,
  });
}

describe('hasExplicitRecurrence', () => {
  it('detects daily / every-day / every-weekday cadences DATE_RE misses', () => {
    expect(hasExplicitRecurrence('every day at 9pm')).toBe(true);
    expect(hasExplicitRecurrence('daily check-in at 10pm')).toBe(true);
    expect(hasExplicitRecurrence('every weekday at 6am')).toBe(true);
    expect(hasExplicitRecurrence('every morning at 7')).toBe(true);
    expect(hasExplicitRecurrence('every Sunday at 10am')).toBe(true);
  });
  it('is false for a one-off utterance', () => {
    expect(hasExplicitRecurrence('dentist tomorrow at 2pm')).toBe(false);
  });

  it('does NOT trip on bare "every"/"each" followed by a non-cadence word', () => {
    // The gate is the sole code guard against a spurious recurring EventKit write,
    // so "each"/"every" alone must not satisfy it.
    expect(hasExplicitRecurrence('check each task at 10am')).toBe(false);
    expect(hasExplicitRecurrence('remind everyone at noon')).toBe(false);
    expect(hasExplicitRecurrence('every effort counts at 9am')).toBe(false);
  });

  it('matches interval cadences ("every other friday", "every two weeks")', () => {
    expect(hasExplicitRecurrence('every other friday at 5pm')).toBe(true);
    expect(hasExplicitRecurrence('every two weeks at 9am')).toBe(true);
  });
});

describe('resolveCaptureTier — recurring calendar_add', () => {
  it('executes a weekly recurrence (every Sunday at 10am) at high tier', () => {
    const res = resolveCaptureTier(
      [calendarAction({ recurrence: { frequency: 'weekly', daysOfWeek: [0], interval: 1 } })],
      'schedule a workout every Sunday at 10am every week',
      NOW
    );
    expect(res.tier).toBe('high');
    expect(res.actions[0].type).toBe('calendar_add');
    expect(res.actions[0].recurrence).toBeTruthy();
  });

  it('executes a daily/weekday recurrence that DATE_RE would have missed', () => {
    const weekday = resolveCaptureTier(
      [calendarAction({ title: 'Run', recurrence: { frequency: 'weekly', daysOfWeek: [1, 2, 3, 4, 5] } })],
      'block every weekday at 6am for a run',
      NOW
    );
    expect(weekday.tier).toBe('high');
    expect(weekday.actions[0].type).toBe('calendar_add');

    const daily = resolveCaptureTier(
      [calendarAction({ title: 'Check-in', recurrence: { frequency: 'daily', interval: 1 } })],
      'add a daily check-in with my wife at 10:00 PM',
      NOW
    );
    expect(daily.tier).toBe('high');
    expect(daily.actions[0].type).toBe('calendar_add');
  });

  it('captures a recurring calendar_add to Inbox when the transcript has no clock time', () => {
    const res = resolveCaptureTier(
      [calendarAction({ recurrence: { frequency: 'weekly', daysOfWeek: [0] } })],
      'workout every sunday',
      NOW
    );
    expect(res.actions[0].type).toBe('inbox_add');
  });

  it('still requires explicit date + time for a ONE-OFF calendar_add (regression)', () => {
    const ok = resolveCaptureTier(
      [calendarAction({ title: 'Dentist', startISO: '2026-06-17T14:00:00', endISO: '2026-06-17T15:00:00' })],
      'dentist tomorrow at 2pm',
      NOW
    );
    expect(ok.tier).toBe('high');
    expect(ok.actions[0].type).toBe('calendar_add');

    const noDate = resolveCaptureTier(
      [calendarAction({ title: 'Dentist' })],
      'dentist at 2pm',
      NOW
    );
    expect(noDate.actions[0].type).toBe('inbox_add');
  });
});
