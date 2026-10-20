import { describe, it, expect } from 'vitest';
import { isPinnedNormalized, migratePinsToExcluded, deriveActiveHabitIds } from '../score-inclusion';

const rules = () => [
  { id: 'h1', title: 'Meditation' },
  { id: 'h2', title: 'Read 20 minutes' },
  { id: 'h3', title: 'Workout' },
];

describe('migratePinsToExcluded', () => {
  it('all-pinned cohort (onboarding pins every title) → nothing excluded', () => {
    const out = migratePinsToExcluded(rules(), ['Meditation', 'Read 20 minutes', 'Workout']);
    expect(out.every((r) => r.excludedFromScore === false)).toBe(true);
  });

  it('some pinned → only the un-pinned are excluded', () => {
    const out = migratePinsToExcluded(rules(), ['h1', 'h3']); // pinned by id
    expect(out.find((r) => r.id === 'h1')!.excludedFromScore).toBe(false);
    expect(out.find((r) => r.id === 'h2')!.excludedFromScore).toBe(true); // unpinned
    expect(out.find((r) => r.id === 'h3')!.excludedFromScore).toBe(false);
  });

  it('zero pinned → nothing excluded (old behavior counted everything)', () => {
    const out = migratePinsToExcluded(rules(), []);
    expect(out.every((r) => r.excludedFromScore === false)).toBe(true);
  });

  it('title-pin legacy with emoji/case drift still matches (no false-exclude)', () => {
    const r = [{ id: 'h1', title: '🧘 Meditation' }];
    const out = migratePinsToExcluded(r, ['meditation']); // normalized match
    expect(out[0].excludedFromScore).toBe(false);
  });

  it('is idempotent — preserves an already-set flag', () => {
    const r = [{ id: 'h1', title: 'Meditation', excludedFromScore: true }];
    const out = migratePinsToExcluded(r, ['h1']); // pinned, but flag already set
    expect(out[0].excludedFromScore).toBe(true);
  });
});

describe('deriveActiveHabitIds', () => {
  it('returns non-excluded rule ids (the derived pinnedHabits shim)', () => {
    const r = [
      { id: 'h1', title: 'A', excludedFromScore: false },
      { id: 'h2', title: 'B', excludedFromScore: true },
      { id: 'h3', title: 'C' },
    ];
    expect(deriveActiveHabitIds(r)).toEqual(['h1', 'h3']);
  });
  it('empty when every habit is excluded (the known Phase-2 widget edge)', () => {
    expect(deriveActiveHabitIds([{ id: 'h1', title: 'A', excludedFromScore: true }])).toEqual([]);
  });
});

describe('isPinnedNormalized', () => {
  it('matches by id or normalized title; false when no pins', () => {
    expect(isPinnedNormalized({ id: 'h1', title: 'Meditation' }, ['h1'])).toBe(true);
    expect(isPinnedNormalized({ id: 'h1', title: '🧘 Meditation' }, ['meditation'])).toBe(true);
    expect(isPinnedNormalized({ id: 'h1', title: 'Meditation' }, [])).toBe(false);
  });
});
