/**
 * plan-item-editor.ts — the editor sheet's decisions as pure functions
 * (RN-free, vitest-coverable): which fields a type exposes, and the patch a
 * draft would save or the field errors that block it.
 */

import { validateProposedAction } from '../../utils/recurrence';
import type { ProposedAction } from './command-types';

export type TimeBlock = NonNullable<ProposedAction['preferredTimeBlock']>;
export const TIME_BLOCKS: TimeBlock[] = ['morning', 'afternoon', 'evening', 'night'];

export interface PlanItemDraft {
  title: string;
  time: string;
  dateStr: string;
  daysOfWeek: number[];
  preferredTimeBlock: TimeBlock | null;
  description: string;
}

/** The editor's starting draft for an action. */
export function draftFor(action: ProposedAction): PlanItemDraft {
  return {
    title: action.title,
    time: action.time ?? '',
    dateStr: action.dateStr ?? '',
    daysOfWeek: action.daysOfWeek ?? [],
    preferredTimeBlock: action.preferredTimeBlock ?? null,
    description: action.description ?? '',
  };
}
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The fields the editor exposes for a type. Calendar events keep their ISO span; only the title is editable. */
export function editableFieldsFor(type: ProposedAction['type']): { days: boolean; time: boolean; date: boolean; note: boolean } {
  switch (type) {
    case 'recurring_add':
    case 'recurring_todo_add':
      return { days: true, time: true, date: false, note: false };
    case 'todo_add':
      return { days: false, time: true, date: true, note: false };
    case 'inbox_add':
    case 'align':
      return { days: false, time: false, date: false, note: true };
    default:
      return { days: false, time: false, date: false, note: false };
  }
}

/** Pure: the patch the sheet would save, or the field errors that block it. */
export function buildPatch(
  action: ProposedAction,
  draft: PlanItemDraft,
): { patch: Partial<ProposedAction>; errors: string[] } {
  const fields = editableFieldsFor(action.type);
  const errors: string[] = [];
  const title = draft.title.trim();
  if (!title) errors.push('A title is needed.');
  const patch: Partial<ProposedAction> = { title };
  if (fields.time) {
    const time = draft.time.trim();
    if (time && !TIME_RE.test(time)) errors.push('Time reads as HH:MM, 24 hour.');
    patch.time = time || undefined;
  }
  if (fields.days) {
    if (draft.daysOfWeek.length === 0) errors.push('Pick at least one day.');
    patch.daysOfWeek = [...draft.daysOfWeek].sort((a, b) => a - b);
    // A set time and a time block are two answers to one question.
    patch.preferredTimeBlock = draft.time.trim() ? undefined : draft.preferredTimeBlock ?? undefined;
  }
  if (fields.date) {
    const dateStr = draft.dateStr.trim();
    if (!DATE_RE.test(dateStr)) errors.push('Date reads as YYYY-MM-DD.');
    patch.dateStr = dateStr;
  }
  if (fields.note) {
    const description = draft.description.trim();
    patch.description = description || undefined;
  } else if (action.type === 'recurring_add' || action.type === 'todo_add') {
    // The card's inline editor always mirrored the title into description.
    patch.description = title;
  }
  if (errors.length === 0) {
    const v = validateProposedAction({ ...action, ...patch });
    if (!v.valid) errors.push(...v.errors);
  }
  return { patch, errors };
}

