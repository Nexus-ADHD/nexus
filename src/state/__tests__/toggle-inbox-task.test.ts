import { describe, expect, it } from 'vitest';
import { applyToggleInbox } from '../toggle-inbox-task';

type Task = { id: string; completed: boolean; completedAt?: number };

const NOW = 1_700_000_000_000;

describe('applyToggleInbox', () => {
  it('stamps completedAt on false→true transition', () => {
    const inbox: Task[] = [{ id: 'a', completed: false }];
    const next = applyToggleInbox(inbox, 'a', NOW);
    expect(next[0].completed).toBe(true);
    expect(next[0].completedAt).toBe(NOW);
  });

  it('does NOT clear completedAt on true→false transition', () => {
    const inbox: Task[] = [{ id: 'a', completed: true, completedAt: NOW - 1000 }];
    const next = applyToggleInbox(inbox, 'a', NOW);
    expect(next[0].completed).toBe(false);
    expect(next[0].completedAt).toBe(NOW - 1000);
  });

  it('preserves the first completedAt across complete → uncomplete → re-complete', () => {
    const inbox: Task[] = [{ id: 'a', completed: false }];
    // First completion
    const a = applyToggleInbox(inbox, 'a', NOW);
    expect(a[0].completedAt).toBe(NOW);
    // Un-complete
    const b = applyToggleInbox(a, 'a', NOW + 1000);
    expect(b[0].completed).toBe(false);
    expect(b[0].completedAt).toBe(NOW); // preserved
    // Re-complete with a later "now" — must NOT overwrite
    const c = applyToggleInbox(b, 'a', NOW + 2000);
    expect(c[0].completed).toBe(true);
    expect(c[0].completedAt).toBe(NOW); // still the first
  });

  it('leaves other items untouched', () => {
    const inbox: Task[] = [
      { id: 'a', completed: false },
      { id: 'b', completed: false },
    ];
    const next = applyToggleInbox(inbox, 'a', NOW);
    expect(next[0].completed).toBe(true);
    expect(next[1].completed).toBe(false);
    expect(next[1].completedAt).toBeUndefined();
  });

  it('returns the array unchanged on unknown id', () => {
    const inbox: Task[] = [{ id: 'a', completed: false }];
    const next = applyToggleInbox(inbox, 'nope', NOW);
    expect(next).toHaveLength(1);
    expect(next[0].completed).toBe(false);
  });

  it('returns the input unchanged on empty input', () => {
    const empty: Task[] = [];
    expect(applyToggleInbox(empty, 'a', NOW)).toBe(empty);
  });

  it('does not mutate the input array or items', () => {
    const item: Task = { id: 'a', completed: false };
    const inbox: Task[] = [item];
    const next = applyToggleInbox(inbox, 'a', NOW);
    expect(item.completed).toBe(false);          // input item unchanged
    expect(item.completedAt).toBeUndefined();
    expect(next).not.toBe(inbox);                // new array
    expect(next[0]).not.toBe(item);              // new item
  });
});
