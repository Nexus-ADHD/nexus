/**
 * command-labels.ts
 *
 * Pure helper functions that turn a ProposedAction into human-readable labels.
 * No side effects, no React imports — safe to unit-test in isolation.
 */

import { ProposedAction, ProposedActionType } from './command-types';

const WEEKDAY_SHORT = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] as const;

// ─── Destination ─────────────────────────────────────────────────────────────

const DESTINATION_MAP: Record<ProposedActionType, string> = {
  inbox_add:          'Inbox',
  todo_add:           'Tasks',
  recurring_todo_add: 'Recurring Tasks',
  recurring_add:      'Orbit / Habits',
  calendar_add:       'Calendar',
  align:              'Align / Goals',
};

/** Where in the app the action will land. e.g. "Orbit / Habits" */
export function getActionDestination(action: ProposedAction): string {
  return DESTINATION_MAP[action.type] ?? 'Inbox';
}

// ─── Type label ──────────────────────────────────────────────────────────────

const TYPE_LABEL_MAP: Record<ProposedActionType, string> = {
  inbox_add:          'Capture',
  todo_add:           'Task',
  recurring_todo_add: 'Recurring Task',
  recurring_add:      'Recurring Habit',
  calendar_add:       'Calendar Event',
  align:              'Goal',
};

/** Short, friendly action type. e.g. "Recurring Habit" */
export function getActionTypeLabel(action: ProposedAction): string {
  return TYPE_LABEL_MAP[action.type] ?? action.type;
}

// ─── Timing label ────────────────────────────────────────────────────────────

/**
 * Returns a human-readable timing string for the action, e.g.:
 *  - "Friday Apr 25 at 7:00 PM"
 *  - "Mon · Wed · Fri at 6:00 AM"
 *  - "Every morning"
 *  - "Saturday Apr 26"
 *  - "" (empty) for inbox/align captures
 */
export function getActionTimingLabel(action: ProposedAction): string {
  if (action.type === 'calendar_add' && action.startISO) {
    return formatDateTime(action.startISO);
  }

  if (action.type === 'todo_add' && action.dateStr) {
    return formatDate(action.dateStr);
  }

  if (action.type === 'recurring_add' || action.type === 'recurring_todo_add') {
    const daysPart = formatDays(action.daysOfWeek);
    const timePart = action.time
      ? formatTime24h(action.time)
      : action.preferredTimeBlock
      ? `every ${action.preferredTimeBlock}`
      : '';

    if (daysPart && timePart) return `${daysPart} at ${timePart}`;
    if (daysPart) return daysPart;
    if (timePart) return timePart;
    return 'Days not set';
  }

  return '';
}

// ─── Confidence label ────────────────────────────────────────────────────────

/** Returns a short confidence label with an emoji indicator. */
export function getConfidenceLabel(action: ProposedAction): string {
  switch (action.confidence) {
    case 'high':   return '✓ High confidence';
    case 'medium': return '~ Medium confidence';
    case 'low':    return '? Low confidence';
    default:       return '';
  }
}

// ─── Private formatters ──────────────────────────────────────────────────────

function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString([], {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function formatDate(dateStr: string): string {
  try {
    // Parse YYYY-MM-DD as local date (avoid UTC shift)
    const [y, m, day] = dateStr.split('-').map(Number);
    const d = new Date(y, m - 1, day);
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  } catch {
    return dateStr;
  }
}

function formatTime24h(time: string): string {
  try {
    const [h, m] = time.split(':').map(Number);
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return time;
  }
}

function formatDays(days?: number[]): string {
  if (!days || days.length === 0) return '';
  const sorted = [...new Set(days)].filter(d => d >= 0 && d <= 6).sort((a, b) => a - b);

  if (sorted.length === 7) return 'Every day';
  if (sorted.length === 5 && sorted.join() === '1,2,3,4,5') return 'Weekdays';
  if (sorted.length === 2 && sorted.join() === '0,6') return 'Weekends';

  return sorted.map(d => WEEKDAY_SHORT[d]).join(' · ');
}
