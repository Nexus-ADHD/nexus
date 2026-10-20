/**
 * Pure helper for non-destructive Apple Reminders writes.
 *
 * Why this exists:
 *
 * On iOS 26, expo-calendar's `Calendar.updateReminderAsync` is
 * destructive on partial payloads. Any field NOT included in the
 * payload is interpreted as null/empty and overwrites the
 * reminder's existing value. So sending `{ completed: true }`
 * with the intent of "just toggle the checkbox" wipes the title,
 * notes, alarms, due date, and any other field on the reminder.
 *
 * The fix is read-merge-write: fetch the existing reminder, merge
 * the intended change in, write the complete object back. This
 * file isolates the merge as a pure function so the data-integrity
 * contract is unit-testable without mocking EventKit.
 *
 * Critical invariant: `mergeReminderPatch(existing, patch)` must
 * return an object that has every field the existing reminder
 * had, with ONLY the fields named in `patch` overridden. Missing
 * fields on the existing object normalize to safe defaults (empty
 * arrays, null) so we never write `undefined` to EventKit (which
 * the binding also treats as a wipe).
 */

// Date fields are typed as `Date | string` because expo-calendar's
// Reminder type returns ISO strings from getRemindersAsync but
// accepts Date objects on updateReminderAsync. updateReminderAsync
// is tolerant of both, and we pass the value straight through.
export interface ReminderShape {
  title?: string | null;
  notes?: string | null;
  completed?: boolean | null;
  completionDate?: Date | string | null;
  dueDate?: Date | string | null;
  startDate?: Date | string | null;
  alarms?: any[] | null;
  recurrenceRule?: any | null;
  location?: string | null;
  url?: string | null;
  timeZone?: string | null;
  // Allow extra fields to flow through unchanged — EventKit may
  // expose new fields in future iOS versions and we'd rather pass
  // them along than silently drop them.
  [k: string]: any;
}

/**
 * Default fallback for an existing reminder field. Empty arrays
 * for collections, null for everything else. We never use
 * `undefined` because some EventKit bindings treat that as
 * "delete this field."
 */
function safeDefault(key: keyof ReminderShape): any {
  if (key === 'alarms') return [];
  if (key === 'title') return '';
  if (key === 'completed') return false;
  return null;
}

/**
 * Read-merge-write helper. `existing` is whatever EventKit handed
 * back from a get-by-id (or null if the reminder is missing —
 * caller is expected to handle that case before calling here).
 * `patch` is the intended change.
 *
 * Returns a new object — never mutates inputs. The shape preserves
 * every field on `existing` (with safe defaults for missing fields)
 * and overlays `patch` on top.
 */
export function mergeReminderPatch(
  existing: ReminderShape,
  patch: Partial<ReminderShape>,
): ReminderShape {
  const baseFields: Array<keyof ReminderShape> = [
    'title',
    'notes',
    'completed',
    'completionDate',
    'dueDate',
    'startDate',
    'alarms',
    'recurrenceRule',
    'location',
    'url',
    'timeZone',
  ];
  const out: ReminderShape = { ...existing };
  for (const k of baseFields) {
    if (out[k] === undefined) {
      out[k] = safeDefault(k);
    }
  }
  // Patch wins on every key it carries. Use Object.assign so
  // explicit `null` in the patch correctly clears a field (e.g.
  // un-completing → completionDate: null).
  return Object.assign(out, patch);
}
