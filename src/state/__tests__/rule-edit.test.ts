import { describe, it, expect } from 'vitest';
import { applyRuleEdit, isDuplicateHabitTitle } from '../rule-edit';

const baseState = () => ({
  recurringRules: [
    { id: 'r1', title: 'Meditation', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], timesPerDay: 1 },
    { id: 'r2', title: 'Read', daysOfWeek: [1, 3, 5], timesPerDay: 2 },
  ],
  habitLog: [
    { habitTitle: 'meditation', dateKey: '2026-06-10' },
    { habitTitle: 'read', dateKey: '2026-06-10' },
  ],
  goalHabitMap: { meditation: ['p1'] },
  habitStreaks: { meditation: 5, read: 3 },
  habitStreakUpdatedDate: { meditation: '2026-06-10' },
  habitStrength: { meditation: 0.8 },
});

describe('applyRuleEdit', () => {
  it('updates daysOfWeek + timesPerDay without touching the title re-key', () => {
    const s = baseState();
    const out = applyRuleEdit(s, 'r2', { daysOfWeek: [5, 1, 3], timesPerDay: 4 });
    const r2 = out.recurringRules.find((r: any) => r.id === 'r2');
    expect(r2.daysOfWeek).toEqual([1, 3, 5]); // deduped + sorted
    expect(r2.timesPerDay).toBe(4);
    // no re-key slices when title unchanged
    expect(out.goalHabitMap).toBeUndefined();
    expect(out.habitLog).toBeUndefined();
    expect(out.habitStreaks).toBeUndefined();
  });

  it('re-keys habitLog, goalHabitMap, and streak maps on a title change', () => {
    const s = baseState();
    const out = applyRuleEdit(s, 'r1', { title: 'Stillness' });
    expect(out.recurringRules.find((r: any) => r.id === 'r1').title).toBe('Stillness');
    expect(out.habitLog.filter((e: any) => e.habitTitle === 'stillness')).toHaveLength(1);
    expect(out.habitLog.some((e: any) => e.habitTitle === 'meditation')).toBe(false);
    expect(out.goalHabitMap.stillness).toEqual(['p1']);
    expect(out.goalHabitMap.meditation).toBeUndefined();
    expect(out.habitStreaks.stillness).toBe(5);
    expect(out.habitStreaks.meditation).toBeUndefined();
    expect(out.habitStrength.stillness).toBe(0.8);
  });

  it('skips the re-key when the normalized title is unchanged (no-op rename)', () => {
    const s = baseState();
    const out = applyRuleEdit(s, 'r1', { title: '  Meditation  ', daysOfWeek: [0, 1, 2] });
    // field edit applies, but no re-key slices emitted
    expect(out.recurringRules.find((r: any) => r.id === 'r1').daysOfWeek).toEqual([0, 1, 2]);
    expect(out.goalHabitMap).toBeUndefined();
    expect(out.habitLog).toBeUndefined();
  });

  // NEX-206 (Or-3): preferredTimeBlock + appleEventId are scalar field edits —
  // no habit-log/streak re-key — applied atomically so accept and undo-timing
  // never leave a rule carrying a block without its backing Apple event.
  it('sets preferredTimeBlock + appleEventId together on accept (scalar, no re-key)', () => {
    const s = baseState();
    const out = applyRuleEdit(s, 'r1', {
      preferredTimeBlock: 'afternoon',
      appleEventId: 'evt_123',
    });
    const r1 = out.recurringRules.find((r: any) => r.id === 'r1');
    expect(r1.preferredTimeBlock).toBe('afternoon');
    expect(r1.appleEventId).toBe('evt_123');
    // pure scalar edit — no title re-key slices
    expect(out.goalHabitMap).toBeUndefined();
    expect(out.habitLog).toBeUndefined();
    expect(out.habitStreaks).toBeUndefined();
  });

  it('reverts preferredTimeBlock + appleEventId to null on undo-timing', () => {
    const s = baseState();
    // accept, then undo: the rule carried a block + linked event, undo clears both
    s.recurringRules[0] = {
      ...s.recurringRules[0],
      preferredTimeBlock: 'afternoon',
      appleEventId: 'evt_123',
    } as any;
    const out = applyRuleEdit(s, 'r1', { preferredTimeBlock: null, appleEventId: null });
    const r1 = out.recurringRules.find((r: any) => r.id === 'r1');
    expect(r1.preferredTimeBlock).toBeNull();
    expect(r1.appleEventId).toBeNull();
  });

  it('leaves preferredTimeBlock untouched when the patch omits it', () => {
    const s = baseState();
    s.recurringRules[0] = { ...s.recurringRules[0], preferredTimeBlock: 'morning' } as any;
    const out = applyRuleEdit(s, 'r1', { daysOfWeek: [1, 2] });
    const r1 = out.recurringRules.find((r: any) => r.id === 'r1');
    expect(r1.preferredTimeBlock).toBe('morning'); // undefined patch field = no change
  });

  // NEX-202: mandateEchoPillarId is a scalar edit (no re-key); anchor sets it,
  // sever clears it to null, and omitting it leaves it untouched.
  it('anchors + severs mandateEchoPillarId (scalar, no re-key)', () => {
    const s = baseState();
    const anchored = applyRuleEdit(s, 'r1', { mandateEchoPillarId: 'p9' });
    expect(anchored.recurringRules.find((r: any) => r.id === 'r1').mandateEchoPillarId).toBe('p9');
    // no title re-key slices for a pure scalar edit
    expect(anchored.goalHabitMap).toBeUndefined();
    expect(anchored.habitLog).toBeUndefined();

    s.recurringRules[0] = { ...s.recurringRules[0], mandateEchoPillarId: 'p9' } as any;
    const severed = applyRuleEdit(s, 'r1', { mandateEchoPillarId: null });
    expect(severed.recurringRules.find((r: any) => r.id === 'r1').mandateEchoPillarId).toBeNull();
  });

  it('leaves mandateEchoPillarId untouched when the patch omits it', () => {
    const s = baseState();
    s.recurringRules[0] = { ...s.recurringRules[0], mandateEchoPillarId: 'p9' } as any;
    const out = applyRuleEdit(s, 'r1', { timesPerDay: 3 });
    expect(out.recurringRules.find((r: any) => r.id === 'r1').mandateEchoPillarId).toBe('p9');
  });

  // NEX-208: firstStep is a scalar edit (no re-key); set, clear, omit, and it
  // survives a title rename.
  it('sets + clears firstStep without re-keying', () => {
    const s = baseState();
    const set = applyRuleEdit(s, 'r2', { firstStep: 'open the book' });
    expect(set.recurringRules.find((r: any) => r.id === 'r2').firstStep).toBe('open the book');
    expect(set.goalHabitMap).toBeUndefined(); // pure scalar — no re-key slices
    expect(set.habitLog).toBeUndefined();

    s.recurringRules[1] = { ...s.recurringRules[1], firstStep: 'open the book' } as any;
    const cleared = applyRuleEdit(s, 'r2', { firstStep: null });
    expect(cleared.recurringRules.find((r: any) => r.id === 'r2').firstStep).toBeNull();
  });

  it('leaves firstStep untouched when the patch omits it', () => {
    const s = baseState();
    s.recurringRules[0] = { ...s.recurringRules[0], firstStep: 'one breath' } as any;
    const out = applyRuleEdit(s, 'r1', { timesPerDay: 2 });
    expect(out.recurringRules.find((r: any) => r.id === 'r1').firstStep).toBe('one breath');
  });

  it('preserves firstStep across a title rename', () => {
    const s = baseState();
    s.recurringRules[0] = { ...s.recurringRules[0], firstStep: 'one breath' } as any;
    const out = applyRuleEdit(s, 'r1', { title: 'Stillness' });
    const r1 = out.recurringRules.find((r: any) => r.id === 'r1');
    expect(r1.title).toBe('Stillness');
    expect(r1.firstStep).toBe('one breath'); // carried over the re-key
  });

  // NEX-209: cue is a scalar edit (no re-key); set, clear, omit, survives rename.
  it('sets + clears cue without re-keying', () => {
    const s = baseState();
    const set = applyRuleEdit(s, 'r2', { cue: 'After morning coffee' });
    expect(set.recurringRules.find((r: any) => r.id === 'r2').cue).toBe('After morning coffee');
    expect(set.goalHabitMap).toBeUndefined();
    expect(set.habitLog).toBeUndefined();

    s.recurringRules[1] = { ...s.recurringRules[1], cue: 'After morning coffee' } as any;
    const cleared = applyRuleEdit(s, 'r2', { cue: null });
    expect(cleared.recurringRules.find((r: any) => r.id === 'r2').cue).toBeNull();
  });

  it('leaves cue untouched when the patch omits it', () => {
    const s = baseState();
    s.recurringRules[0] = { ...s.recurringRules[0], cue: 'Before bed' } as any;
    const out = applyRuleEdit(s, 'r1', { timesPerDay: 2 });
    expect(out.recurringRules.find((r: any) => r.id === 'r1').cue).toBe('Before bed');
  });

  it('preserves cue across a title rename', () => {
    const s = baseState();
    s.recurringRules[0] = { ...s.recurringRules[0], cue: 'Before bed' } as any;
    const out = applyRuleEdit(s, 'r1', { title: 'Stillness' });
    const r1 = out.recurringRules.find((r: any) => r.id === 'r1');
    expect(r1.title).toBe('Stillness');
    expect(r1.cue).toBe('Before bed');
  });
});

describe('isDuplicateHabitTitle', () => {
  const rules = [
    { id: 'r1', title: 'Meditation' },
    { id: 'r2', title: 'Read' },
  ];
  it('detects a duplicate by normalized title', () => {
    expect(isDuplicateHabitTitle(rules, 'meditation')).toBe(true);
    expect(isDuplicateHabitTitle(rules, '  MEDITATION ')).toBe(true);
  });
  it('excludes the rule being edited (self)', () => {
    expect(isDuplicateHabitTitle(rules, 'Meditation', 'r1')).toBe(false);
  });
  it('returns false for a genuinely new title', () => {
    expect(isDuplicateHabitTitle(rules, 'Stretch')).toBe(false);
  });
});
