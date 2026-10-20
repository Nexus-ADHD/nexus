import { describe, expect, it } from 'vitest';
import { buildPatch, draftFor, editableFieldsFor } from '../plan-item-editor';
import type { ProposedAction } from '../command-types';

const habit: ProposedAction = { type: 'recurring_add', title: 'Ten minutes with her', daysOfWeek: [1, 3, 5], preferredTimeBlock: 'evening', confidence: 'high' };
const todo: ProposedAction = { type: 'todo_add', title: 'How did the week go?', dateStr: '2026-09-09', time: '20:00', confidence: 'high' };
const draftOf = draftFor;

describe('editableFieldsFor', () => {
  it('exposes days and time for habits, date and time for one-offs, a note for inbox and align, nothing else for calendar', () => {
    expect(editableFieldsFor('recurring_add')).toEqual({ days: true, time: true, date: false, note: false });
    expect(editableFieldsFor('todo_add')).toEqual({ days: false, time: true, date: true, note: false });
    expect(editableFieldsFor('inbox_add')).toEqual({ days: false, time: false, date: false, note: true });
    expect(editableFieldsFor('calendar_add')).toEqual({ days: false, time: false, date: false, note: false });
  });
});

describe('buildPatch', () => {
  it('an untouched valid item produces a clean patch', () => {
    const { patch, errors } = buildPatch(habit, draftOf(habit));
    expect(errors).toEqual([]);
    expect(patch).toMatchObject({ title: 'Ten minutes with her', daysOfWeek: [1, 3, 5], preferredTimeBlock: 'evening' });
  });

  it('a set time replaces the time block, and a cleared time restores it', () => {
    const withTime = buildPatch(habit, { ...draftOf(habit), time: '18:30' });
    expect(withTime.errors).toEqual([]);
    expect(withTime.patch.time).toBe('18:30');
    expect(withTime.patch.preferredTimeBlock).toBeUndefined();
    const cleared = buildPatch({ ...habit, time: '18:30' }, { ...draftOf(habit), time: '', preferredTimeBlock: 'morning' });
    expect(cleared.patch.time).toBeUndefined();
    expect(cleared.patch.preferredTimeBlock).toBe('morning');
  });

  it('names the exact field that blocks a save', () => {
    expect(buildPatch(habit, { ...draftOf(habit), title: '  ' }).errors).toContain('A title is needed.');
    expect(buildPatch(habit, { ...draftOf(habit), daysOfWeek: [] }).errors).toContain('Pick at least one day.');
    expect(buildPatch(habit, { ...draftOf(habit), time: '6pm' }).errors).toContain('Time reads as HH:MM, 24 hour.');
    expect(buildPatch(todo, { ...draftOf(todo), dateStr: '9/9' }).errors).toContain('Date reads as YYYY-MM-DD.');
  });

  it('sorts days and mirrors the title into description for habits and one-offs, as the old inline editor did', () => {
    const { patch } = buildPatch(habit, { ...draftOf(habit), daysOfWeek: [5, 1] });
    expect(patch.daysOfWeek).toEqual([1, 5]);
    expect(patch.description).toBe('Ten minutes with her');
    const inbox = buildPatch({ type: 'inbox_add', title: 'Read chapter 1' }, { title: 'Read chapter 1', time: '', dateStr: '', daysOfWeek: [], preferredTimeBlock: null, description: ' Siegel ' });
    expect(inbox.patch.description).toBe('Siegel');
  });

  it('copy never carries an exclamation point or em dash', () => {
    const all = [
      ...buildPatch(habit, { ...draftOf(habit), title: '' }).errors,
      ...buildPatch(habit, { ...draftOf(habit), daysOfWeek: [], time: 'x' }).errors,
      ...buildPatch(todo, { ...draftOf(todo), dateStr: '' }).errors,
    ];
    for (const line of all) expect(line).not.toMatch(/[!—]/);
  });
});
