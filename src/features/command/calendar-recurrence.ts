import { normalizeDaysOfWeek, type ProposedAction } from '../../utils/recurrence';

// JS weekday (0 = Sunday … 6 = Saturday) → expo-calendar DayOfTheWeek value
// (Sunday = 1 … Saturday = 7, i.e. JS day + 1). This mirrors CALENDAR_DAY_MAP in
// app/(tabs)/index.tsx, but is kept as plain numbers here so this module never
// imports expo-calendar and stays pure-Node testable (vitest config is Node-only
// and the codebase keeps native calls out of pure modules via dependency
// injection — see command-executor.ts).
const JS_DAY_TO_CALENDAR_DAY: Record<number, number> = {
  0: 1,
  1: 2,
  2: 3,
  3: 4,
  4: 5,
  5: 6,
  6: 7,
};

// Structurally compatible with expo-calendar's RecurrenceRule: `frequency`'s
// string values equal Calendar.Frequency.{DAILY,WEEKLY}, and `dayOfTheWeek`'s
// numbers equal Calendar.DayOfTheWeek values. The single enum boundary cast
// happens at the call site (createCalendarEventCb), so this module stays pure.
export interface CalendarRecurrenceRule {
  frequency: 'daily' | 'weekly';
  interval: number;
  daysOfTheWeek?: { dayOfTheWeek: number }[];
}

// Local weekday (0 = Sunday … 6 = Saturday) of an event's ISO start string, or
// undefined when it can't be parsed. MUST use getDay() (LOCAL), never getUTCDay():
// a start of "…T23:00:00" on a Sunday is Monday in UTC for zones west of UTC,
// which is exactly the wrong-weekday bug. The local weekday also matches the
// `startDate` EventKit anchors to at the call site (also `new Date(startISO)`),
// so the first occurrence and the repeat day derive from one immutable string.
function weekdayFromISO(startISO: string): number | undefined {
  if (!startISO) return undefined;
  const date = new Date(startISO);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.getDay();
}

// Map a calendar_add action's nested `recurrence` → an expo-calendar-shaped
// recurrence rule. Returns undefined when the action carries no recurrence
// (→ a one-off event, unchanged behavior). `daysOfTheWeek` is omitted for daily
// rules.
//
// For a single-day or empty WEEKLY rule the repeat day is anchored to the start
// date's LOCAL weekday (`startISO`). EventKit renders the first occurrence on
// `startDate` and every later occurrence on the rule's `daysOfTheWeek`; the model
// sources `startISO` and `recurrence.daysOfWeek` independently and can disagree,
// which made a "every Sunday" block repeat on Monday. Deriving the anchor from the
// same `startISO` that feeds `startDate` makes that disagreement structurally
// impossible. An EXPLICIT multi-day set (e.g. Mon/Wed/Fri) is preserved exactly —
// the start is not grafted in. `startISO` is required so every caller supplies the
// anchor.
export function buildCalendarRecurrenceRule(
  action: Pick<ProposedAction, 'recurrence'>,
  startISO: string
): CalendarRecurrenceRule | undefined {
  const recurrence = action.recurrence;
  if (!recurrence) return undefined;

  // Fail SAFE on an unrecognized frequency: a one-off (undefined) beats inventing
  // a weekly cadence the user never asked for. validateProposedAction already
  // rejects such an action upstream; this is defense in depth.
  const frequency = recurrence.frequency;
  if (frequency !== 'daily' && frequency !== 'weekly') return undefined;
  const interval =
    typeof recurrence.interval === 'number' &&
    Number.isInteger(recurrence.interval) &&
    recurrence.interval >= 1
      ? recurrence.interval
      : 1;

  // Daily rules carry no day constraint — unchanged.
  if (frequency === 'daily') {
    return { frequency, interval };
  }

  const days = normalizeDaysOfWeek(recurrence.daysOfWeek);
  const startWeekday = weekdayFromISO(startISO);

  let anchoredDays: number[];
  if (startWeekday !== undefined && days.length <= 1) {
    // Empty or a single day → the start date wins outright. It is the occurrence
    // the user saw and confirmed; a lone model-picked day that disagrees with the
    // start is the wrong-weekday bug being removed.
    anchoredDays = [startWeekday];
  } else {
    // Multiple EXPLICIT days (e.g. Mon/Wed/Fri) → preserve them exactly. Never
    // graft the start weekday in: that would add a recurring day the user never
    // requested. (This branch also covers the defensive case where startISO is
    // unparseable — fall back to the normalized days rather than inventing one.)
    // If the model mis-dated the start to a weekday outside the set, EventKit
    // renders a one-time off-rule first occurrence on startDate that then
    // self-corrects to the requested days — strictly better than a permanent
    // extra weekday.
    anchoredDays = days;
  }

  if (anchoredDays.length === 0) {
    return { frequency, interval };
  }

  return {
    frequency,
    interval,
    daysOfTheWeek: anchoredDays.map((d) => ({ dayOfTheWeek: JS_DAY_TO_CALENDAR_DAY[d] })),
  };
}
