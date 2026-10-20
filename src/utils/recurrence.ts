export const WEEKDAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] as const;

/**
 * Full day names, indexed 0 = Sunday to match WEEKDAY_LABELS and every
 * `daysOfWeek` array in the app.
 *
 * These exist for SCREEN READERS: a day control renders "Mo", and a screen
 * reader announcing "Mo" is close to useless — the accessible name has to be
 * the real word. They live here, in a neutral utility, rather than in the UI
 * kit, because app state and services need the same labels and must never
 * import from `src/components/ui`.
 */
export const WEEKDAY_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
] as const;

/** Three-letter abbreviations, for prose like "Every Mon, Wed". 0 = Sunday. */
export const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export const TIME_BLOCKS = ['morning', 'afternoon', 'evening', 'night'] as const;

export type TimeBlock = (typeof TIME_BLOCKS)[number];

export type ProposedActionType =
  | 'calendar_add'
  | 'inbox_add'
  | 'align'
  | 'recurring_add'
  | 'todo_add'
  | 'recurring_todo_add';

export interface ProposedAction {
  type: ProposedActionType;
  title: string;
  startISO?: string;
  endISO?: string;
  description?: string;
  daysOfWeek?: number[];
  time?: string;
  preferredTimeBlock?: TimeBlock;
  timesPerDay?: number;
  nextAction?: string;
  dateStr?: string;
  confidence?: 'high' | 'medium' | 'low';
  missingFields?: string[];
  explanation?: string;
  // Week-interval for recurring_todo_add. 1 = every week (default), 2 = biweekly,
  // 3 = every 3 weeks, etc. The materializer (today-rollup, widget-bridge)
  // already respects this against the rule's intervalAnchorDate. Voice path
  // wires "every other Tuesday" / "biweekly" / "every two weeks" → interval: 2.
  interval?: number;
  // Recurrence for calendar_add ONLY (a repeating Apple Calendar event). Kept
  // as a nested object so it never conflates with the flat habit-level
  // daysOfWeek/interval above (those drive the recurring_add/recurring_todo_add
  // paths). Absent = a one-off event (unchanged behavior). buildCalendarRecurrenceRule
  // (src/features/command/calendar-recurrence.ts) maps this → an expo-calendar rule.
  recurrence?: {
    frequency: 'daily' | 'weekly';
    interval?: number;
    daysOfWeek?: number[];
  };
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  missingFields: string[];
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function getLocalDateKey(dateInput: string | Date): string {
  if (typeof dateInput === 'string' && DATE_ONLY_RE.test(dateInput)) {
    return dateInput;
  }

  const date = new Date(dateInput);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Normalize a sort/display date fallback that call sites pass as either a
// day-key string or a Date (several Orbit helpers receive `selectedDate`
// directly). Contract: null/undefined/invalid stays null — callers depend on
// a missing fallback passing through unchanged (no-date events keep their own
// default paths); never default to "now" here.
export function normalizeFallbackDateKey(
  fallback: string | Date | null | undefined,
): string | null {
  if (fallback == null || fallback === '') return null;
  const key = getLocalDateKey(fallback);
  return key.includes('NaN') ? null : key;
}

export function normalizeDaysOfWeek(days?: number[]): number[] {
  if (!Array.isArray(days)) return [];
  return Array.from(new Set(days))
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    .sort((a, b) => a - b);
}

function normalizeTimesPerDay(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const intVal = Math.round(value);
  if (intVal < 1) return undefined;
  return Math.min(12, intVal);
}

// Sanitize a calendar_add recurrence object (NOT the flat habit fields):
// dedupe/sort days to 0–6, clamp interval to an integer ≥1 (else drop so the
// writer defaults to 1), and pass frequency through untouched so validation can
// reject an invalid value. Returns undefined when there's no recurrence object.
function normalizeCalendarRecurrence(
  recurrence: ProposedAction['recurrence']
): ProposedAction['recurrence'] {
  if (!recurrence || typeof recurrence !== 'object') return undefined;
  const days = normalizeDaysOfWeek(recurrence.daysOfWeek);
  const rawInterval = recurrence.interval;
  const interval =
    typeof rawInterval === 'number' && Number.isInteger(rawInterval) && rawInterval >= 1
      ? rawInterval
      : undefined;
  return {
    frequency: recurrence.frequency,
    ...(interval !== undefined ? { interval } : {}),
    ...(days.length ? { daysOfWeek: days } : {}),
  };
}

export function normalizeProposedAction(action: ProposedAction): ProposedAction {
  return {
    ...action,
    title: action.title?.trim?.() ?? '',
    time: action.time?.trim?.() || undefined,
    daysOfWeek: normalizeDaysOfWeek(action.daysOfWeek),
    timesPerDay: normalizeTimesPerDay(action.timesPerDay),
    recurrence: normalizeCalendarRecurrence(action.recurrence),
    missingFields: Array.isArray(action.missingFields) ? action.missingFields : [],
  };
}

export function isValidDateString(value?: string): boolean {
  if (!value) return false;
  const time = new Date(value).getTime();
  return !Number.isNaN(time);
}

export function validateProposedAction(rawAction: ProposedAction): ValidationResult {
  const action = normalizeProposedAction(rawAction);
  const result: ValidationResult = {
    valid: true,
    errors: [],
    missingFields: [],
  };

  if (!action.type) {
    result.valid = false;
    result.errors.push('Action type is required.');
  }

  if (!action.title) {
    result.valid = false;
    result.errors.push('Title is required.');
  }

  // NEX-194 (save-and-surface): a recurring_add (habit) with empty/missing
  // days is ACCEPTED — the executor defaults it to today-only so it surfaces
  // on Home's Today's Habits the same day (see command-executor.ts +
  // scheduling-default.ts). Without this, the empty-days today-only default
  // was unreachable: validation rejected the capture before the executor ran.
  // recurring_todo_add still requires an explicit day (the parser deliberately
  // flags missing days for those; refining that flow is NEX-197, out of scope).
  if (action.type === 'recurring_todo_add') {
    if (!action.daysOfWeek || action.daysOfWeek.length === 0) {
      result.valid = false;
      result.missingFields.push('daysOfWeek');
      result.errors.push('Recurring items require at least one active day.');
    }
  }

  if (action.type === 'recurring_add' && !action.time && !action.preferredTimeBlock && !(action.timesPerDay && action.timesPerDay >= 1)) {
    // A recurring_add is valid as a habit if it carries a timesPerDay frequency
    // (e.g. "twice a day" mantras) — no clock time required. Otherwise it must
    // have a time or a preferredTimeBlock.
    //
    // NEX-206 (Or-3): this gate is intentionally KEPT. A bare time-less habit
    // ("meditate every day") is not rejected in the capture flow — prepareAction
    // (confidence-tier.ts) defaults it to timesPerDay:1 before execution, so it
    // reaches the executor's time-less branch and gets the one-tap block offer
    // there. Relaxing this gate would only change the applyClarification fallback
    // (out of NEX-206 scope), so the offer rides the existing prepareAction net.
    result.valid = false;
    result.missingFields.push('time');
    result.errors.push('Recurring habits need a time, a time block, or a "times per day" frequency.');
  }

  if (action.type === 'todo_add') {
    if (!action.dateStr || !DATE_ONLY_RE.test(getLocalDateKey(action.dateStr))) {
      result.valid = false;
      result.missingFields.push('dateStr');
      result.errors.push('One-off tasks require a valid date.');
    }
  }

  if (action.type === 'calendar_add') {
    const hasValidStart = isValidDateString(action.startISO);
    const hasValidEnd = isValidDateString(action.endISO);

    if (!hasValidStart) {
      result.valid = false;
      result.missingFields.push('startISO');
      result.errors.push('Calendar events require a valid start date.');
    }

    if (!hasValidEnd) {
      result.valid = false;
      result.missingFields.push('endISO');
      result.errors.push('Calendar events require a valid end date.');
    }

    if (hasValidStart && hasValidEnd) {
      if (new Date(action.startISO!).getTime() >= new Date(action.endISO!).getTime()) {
        result.valid = false;
        result.errors.push('End time must be after start time.');
      }
    }

    // Recurrence is OPTIONAL — absent keeps the one-off behavior. When present,
    // the frequency check is the load-bearing gate (an unsupported frequency like
    // "monthly" passes through normalization untouched, so it's rejected here →
    // the action is captured to Inbox rather than silently coerced to weekly).
    // The day/interval branches read the RAW object so a direct caller passing an
    // un-normalized action (e.g. a unit test) is still rejected; in the live
    // pipeline normalizeProposedAction has already sanitized those to safe values,
    // so they're belt-and-suspenders there. The AI is the producer.
    const recurrence = rawAction.recurrence;
    if (recurrence !== undefined && recurrence !== null) {
      if (recurrence.frequency !== 'daily' && recurrence.frequency !== 'weekly') {
        result.valid = false;
        result.errors.push('Recurring calendar events must repeat daily or weekly.');
      }
      if (
        recurrence.interval !== undefined &&
        !(Number.isInteger(recurrence.interval) && recurrence.interval >= 1)
      ) {
        result.valid = false;
        result.errors.push('Recurrence interval must be a whole number of 1 or more.');
      }
      const daysOutOfRange = (days: number[]) =>
        days.some((d) => !Number.isInteger(d) || d < 0 || d > 6);
      if (recurrence.frequency === 'weekly') {
        // A weekly rule needs at least one explicit day. Without it the writer
        // would fall back to expo-calendar's implicit "same weekday as startDate"
        // default and could repeat on the wrong day forever — reject so the user
        // sets it deliberately (captured to Inbox).
        if (!Array.isArray(recurrence.daysOfWeek) || recurrence.daysOfWeek.length === 0) {
          result.valid = false;
          result.errors.push('Weekly recurrence requires at least one day in daysOfWeek.');
        } else if (daysOutOfRange(recurrence.daysOfWeek)) {
          result.valid = false;
          result.errors.push('Recurrence days must be between 0 (Sunday) and 6 (Saturday).');
        }
      } else if (
        recurrence.daysOfWeek !== undefined &&
        (!Array.isArray(recurrence.daysOfWeek) || daysOutOfRange(recurrence.daysOfWeek))
      ) {
        result.valid = false;
        result.errors.push('Recurrence days must be between 0 (Sunday) and 6 (Saturday).');
      }
    }
  }

  return result;
}
