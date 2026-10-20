import { describe, expect, it } from 'vitest';
import { buildCalendarRecurrenceRule } from '../calendar-recurrence';
import type { ProposedAction } from '../../../utils/recurrence';

// Pin a fixed NON-UTC zone. Node honors a runtime TZ change for subsequent Date
// calls, and the module under test reads Date only at call time (never at import),
// so setting it here — before any test runs — is enough. This makes every fixture
// weekday deterministic in CI (independent of the runner's zone) AND lets the
// late-night case actually distinguish getDay() from getUTCDay(): an
// 11pm-Sunday-local start is Monday in UTC, so a UTC runner would make that guard
// vacuous. In America/Chicago: 2026-07-05=Sun, 2026-07-06=Mon, 2026-07-10=Fri,
// 2026-07-11=Sat.
process.env.TZ = 'America/Chicago';

// Make voice-scheduled RECURRING calendar blocks create a genuinely repeating
// Apple Calendar event. buildCalendarRecurrenceRule maps a calendar_add action's
// nested `recurrence` → an expo-calendar-shaped recurrenceRule (frequency string
// values === Calendar.Frequency, dayOfTheWeek numbers === Calendar.DayOfTheWeek,
// JS day 0–6 → 1–7), anchoring a weekly rule's day(s) to the start date's local
// weekday. It is pure (no expo-calendar import) so it's testable here.

// Coherent starts (weekday agrees with the days) so the mapping/normalization
// assertions stay meaningful — the anchor doesn't silently rewrite the day.
const SUN = '2026-07-05T10:00:00'; // Sunday
const MON = '2026-07-06T10:00:00'; // Monday
const FRI = '2026-07-10T10:00:00'; // Friday
const SAT = '2026-07-11T10:00:00'; // Saturday

const withRecurrence = (recurrence: ProposedAction['recurrence']): ProposedAction => ({
  type: 'calendar_add',
  title: 'Workout',
  startISO: '2026-07-05T10:00:00',
  endISO: '2026-07-05T11:00:00',
  recurrence,
});

describe('buildCalendarRecurrenceRule', () => {
  it('returns undefined when the action carries no recurrence (one-off)', () => {
    const action: ProposedAction = { type: 'calendar_add', title: 'Dentist' };
    expect(buildCalendarRecurrenceRule(action, SUN)).toBeUndefined();
  });

  it('fails safe to undefined (one-off) on an unrecognized frequency', () => {
    // An off-spec frequency (validation rejects it upstream) must never silently
    // become a weekly event — cast through unknown to exercise the guard.
    const action = {
      type: 'calendar_add',
      title: 'Thing',
      recurrence: { frequency: 'monthly', daysOfWeek: [0] },
    } as unknown as ProposedAction;
    expect(buildCalendarRecurrenceRule(action, SUN)).toBeUndefined();
  });

  it('maps weekly + daysOfWeek to daysOfTheWeek with JS-day + 1 (Sunday 0 → 1)', () => {
    const rule = buildCalendarRecurrenceRule(
      withRecurrence({ frequency: 'weekly', daysOfWeek: [0], interval: 1 }),
      SUN
    );
    expect(rule).toEqual({
      frequency: 'weekly',
      interval: 1,
      daysOfTheWeek: [{ dayOfTheWeek: 1 }],
    });
  });

  it('maps every weekday (1–5) to dayOfTheWeek 2–6', () => {
    const rule = buildCalendarRecurrenceRule(
      withRecurrence({ frequency: 'weekly', daysOfWeek: [1, 2, 3, 4, 5] }),
      MON // Monday is in the set → no graft
    );
    expect(rule?.daysOfTheWeek).toEqual([
      { dayOfTheWeek: 2 },
      { dayOfTheWeek: 3 },
      { dayOfTheWeek: 4 },
      { dayOfTheWeek: 5 },
      { dayOfTheWeek: 6 },
    ]);
  });

  it('maps Saturday (6) to dayOfTheWeek 7', () => {
    const rule = buildCalendarRecurrenceRule(
      withRecurrence({ frequency: 'weekly', daysOfWeek: [6] }),
      SAT // single day → start wins; Saturday start keeps the 6 → 7 mapping
    );
    expect(rule?.daysOfTheWeek).toEqual([{ dayOfTheWeek: 7 }]);
  });

  it('omits daysOfTheWeek for a daily rule', () => {
    const rule = buildCalendarRecurrenceRule(
      withRecurrence({ frequency: 'daily', interval: 1 }),
      SUN
    );
    expect(rule).toEqual({ frequency: 'daily', interval: 1 });
    expect(rule).not.toHaveProperty('daysOfTheWeek');
  });

  it('ignores days on a daily rule (frequency wins, start ignored)', () => {
    const rule = buildCalendarRecurrenceRule(
      withRecurrence({ frequency: 'daily', daysOfWeek: [0, 3] }),
      MON
    );
    expect(rule).not.toHaveProperty('daysOfTheWeek');
  });

  it('preserves an interval greater than 1', () => {
    const rule = buildCalendarRecurrenceRule(
      withRecurrence({ frequency: 'weekly', daysOfWeek: [5], interval: 2 }),
      FRI // single day → start wins; Friday start keeps the 5 → 6 mapping
    );
    expect(rule).toEqual({
      frequency: 'weekly',
      interval: 2,
      daysOfTheWeek: [{ dayOfTheWeek: 6 }],
    });
  });

  it('defaults a missing or invalid interval to 1', () => {
    expect(
      buildCalendarRecurrenceRule(
        withRecurrence({ frequency: 'weekly', daysOfWeek: [0] }),
        SUN
      )?.interval
    ).toBe(1);
    expect(
      buildCalendarRecurrenceRule(
        withRecurrence({ frequency: 'weekly', daysOfWeek: [0], interval: 0 }),
        SUN
      )?.interval
    ).toBe(1);
  });

  it('dedupes and sorts out-of-order / duplicate days', () => {
    const rule = buildCalendarRecurrenceRule(
      withRecurrence({ frequency: 'weekly', daysOfWeek: [5, 1, 5, 3] }),
      MON // Monday ∈ {1,3,5} → no graft
    );
    expect(rule?.daysOfTheWeek).toEqual([
      { dayOfTheWeek: 2 },
      { dayOfTheWeek: 4 },
      { dayOfTheWeek: 6 },
    ]);
  });

  // --- Start-anchoring (the fix): the start weekday is the source of truth ---

  it('anchors to the start weekday when a single day disagrees (the exact regression)', () => {
    // "every Sunday": startISO is Sunday (correct), but daysOfWeek says Monday
    // (corrupted). The rule must resolve to Sunday so the first occurrence and
    // every repeat both land on Sunday.
    const rule = buildCalendarRecurrenceRule(
      withRecurrence({ frequency: 'weekly', daysOfWeek: [1], interval: 1 }),
      SUN
    );
    expect(rule).toEqual({
      frequency: 'weekly',
      interval: 1,
      daysOfTheWeek: [{ dayOfTheWeek: 1 }], // Sunday, not Monday
    });
  });

  it('anchors a weekly rule with empty days to the start weekday', () => {
    const rule = buildCalendarRecurrenceRule(
      withRecurrence({ frequency: 'weekly', daysOfWeek: [] }),
      SUN
    );
    expect(rule).toEqual({
      frequency: 'weekly',
      interval: 1,
      daysOfTheWeek: [{ dayOfTheWeek: 1 }],
    });
  });

  it('keeps a multi-day set intact (no duplicate) when the start is already in it', () => {
    const rule = buildCalendarRecurrenceRule(
      withRecurrence({ frequency: 'weekly', daysOfWeek: [1, 3, 5] }), // Mon/Wed/Fri
      MON
    );
    expect(rule?.daysOfTheWeek).toEqual([
      { dayOfTheWeek: 2 },
      { dayOfTheWeek: 4 },
      { dayOfTheWeek: 6 },
    ]);
  });

  it('preserves an explicit multi-day set exactly when the start weekday is outside it', () => {
    // Mon/Wed/Fri with a Sunday start → the explicit set is kept verbatim; the
    // start is NOT grafted in (no unrequested recurring Sunday). The mismatched
    // start yields at most a one-time off-rule first occurrence, which then
    // self-corrects to the requested days.
    const rule = buildCalendarRecurrenceRule(
      withRecurrence({ frequency: 'weekly', daysOfWeek: [1, 3, 5] }),
      SUN
    );
    expect(rule?.daysOfTheWeek).toEqual([
      { dayOfTheWeek: 2 }, // Mon
      { dayOfTheWeek: 4 }, // Wed
      { dayOfTheWeek: 6 }, // Fri
    ]);
  });

  it('uses the LOCAL weekday of a late-night start, not the UTC day', () => {
    // 11pm Sunday local = Monday in UTC (under America/Chicago). getUTCDay() would
    // wrongly yield Monday; getDay() correctly yields Sunday.
    const rule = buildCalendarRecurrenceRule(
      withRecurrence({ frequency: 'weekly', daysOfWeek: [1] }),
      '2026-07-05T23:00:00'
    );
    expect(rule?.daysOfTheWeek).toEqual([{ dayOfTheWeek: 1 }]); // Sunday
  });

  it('falls back to the normalized days when startISO is unparseable (defensive only)', () => {
    // A validated weekly calendar_add always has a parseable start and the sole
    // caller passes it; this branch only protects synthetic callers.
    const rule = buildCalendarRecurrenceRule(
      withRecurrence({ frequency: 'weekly', daysOfWeek: [6] }),
      'not-a-date'
    );
    expect(rule?.daysOfTheWeek).toEqual([{ dayOfTheWeek: 7 }]);
  });
});
