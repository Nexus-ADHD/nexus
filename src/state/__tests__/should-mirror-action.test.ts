import { describe, it, expect } from 'vitest';
import { shouldMirrorAction, buildMirrorPayload } from '../should-mirror-action';

const NEXUS_ID = 'nexus-list-id';

describe('shouldMirrorAction', () => {
  it('inbox_add + connected + nexus list → true', () => {
    expect(shouldMirrorAction({ type: 'inbox_add' }, true, NEXUS_ID)).toBe(true);
  });

  it('todo_add + connected + nexus list → true', () => {
    expect(shouldMirrorAction({ type: 'todo_add' }, true, NEXUS_ID)).toBe(true);
  });

  it('calendar_add → false (belongs in Orbit)', () => {
    expect(shouldMirrorAction({ type: 'calendar_add' }, true, NEXUS_ID)).toBe(false);
  });

  it('recurring_add → false', () => {
    expect(shouldMirrorAction({ type: 'recurring_add' }, true, NEXUS_ID)).toBe(false);
  });

  it('align → false (identity work, not a to-do)', () => {
    expect(shouldMirrorAction({ type: 'align' }, true, NEXUS_ID)).toBe(false);
  });

  it('inbox_add + not connected → false', () => {
    expect(shouldMirrorAction({ type: 'inbox_add' }, false, NEXUS_ID)).toBe(false);
  });

  it('inbox_add + connected + no Nexus list → false', () => {
    expect(shouldMirrorAction({ type: 'inbox_add' }, true, null)).toBe(false);
  });

  it('null/undefined action → false (defensive)', () => {
    expect(shouldMirrorAction(null, true, NEXUS_ID)).toBe(false);
    expect(shouldMirrorAction(undefined, true, NEXUS_ID)).toBe(false);
  });
});

describe('buildMirrorPayload', () => {
  it('inbox_add → only { title }, no dueDate', () => {
    expect(
      buildMirrorPayload({ type: 'inbox_add', title: 'Think about Q1 strategy' }),
    ).toEqual({ title: 'Think about Q1 strategy' });
  });

  it('inbox_add strips hallucinated dateStr/time even if present', () => {
    // The model occasionally emits dateStr/time on captures with no
    // schedule. The pure helper drops them by omission so the mirror
    // never gets a fabricated due date.
    const payload = buildMirrorPayload({
      type: 'inbox_add',
      title: 'Think about Q1 strategy',
      dateStr: '2026-05-04',
      time: '09:00',
      startISO: '2026-05-04T09:00:00',
    });
    expect(payload).toEqual({ title: 'Think about Q1 strategy' });
    expect(payload).not.toHaveProperty('dueDate');
  });

  it('inbox_add trims whitespace on title', () => {
    expect(
      buildMirrorPayload({ type: 'inbox_add', title: '  Workout  ' }),
    ).toEqual({ title: 'Workout' });
  });

  it('inbox_add with empty title → null', () => {
    expect(buildMirrorPayload({ type: 'inbox_add', title: '' })).toBeNull();
    expect(buildMirrorPayload({ type: 'inbox_add', title: '   ' })).toBeNull();
  });

  it('todo_add with date only → dueDate is the date string', () => {
    expect(
      buildMirrorPayload({
        type: 'todo_add',
        title: 'Pick up dry cleaning',
        dateStr: '2026-05-08',
      }),
    ).toEqual({ title: 'Pick up dry cleaning', dueDate: '2026-05-08' });
  });

  it('todo_add with date + valid time → dueDate is full ISO', () => {
    expect(
      buildMirrorPayload({
        type: 'todo_add',
        title: 'Pick up dry cleaning',
        dateStr: '2026-05-08',
        time: '17:00',
      }),
    ).toEqual({
      title: 'Pick up dry cleaning',
      dueDate: '2026-05-08T17:00:00',
    });
  });

  it('todo_add with malformed time → drops time, keeps date', () => {
    expect(
      buildMirrorPayload({
        type: 'todo_add',
        title: 'Pick up dry cleaning',
        dateStr: '2026-05-08',
        time: 'around 5pm',
      }),
    ).toEqual({ title: 'Pick up dry cleaning', dueDate: '2026-05-08' });
  });

  it('todo_add with no date → just title (no fabricated dueDate)', () => {
    expect(
      buildMirrorPayload({
        type: 'todo_add',
        title: 'Pick up dry cleaning',
      }),
    ).toEqual({ title: 'Pick up dry cleaning' });
  });

  it('non-mirrorable action types → null', () => {
    expect(buildMirrorPayload({ type: 'calendar_add', title: 'X' })).toBeNull();
    expect(buildMirrorPayload({ type: 'recurring_add', title: 'X' })).toBeNull();
    expect(buildMirrorPayload({ type: 'align', title: 'X' })).toBeNull();
  });

  it('null/undefined action → null', () => {
    expect(buildMirrorPayload(null)).toBeNull();
    expect(buildMirrorPayload(undefined)).toBeNull();
    expect(buildMirrorPayload({})).toBeNull();
  });
});
