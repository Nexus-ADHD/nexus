import { describe, expect, it } from 'vitest';
import { reconcileHabitLogToRules, reconcileTitleKeyedMap } from '../habit-log-reconcile';
import { normalize } from '../text';

const log = (habitTitle: string, id = habitTitle) => ({ id, habitTitle });

describe('reconcileHabitLogToRules', () => {
  it('re-attaches emoji-orphaned logs to the emoji-stripped rule', () => {
    const habitLog = [log('🧘 meditation'), log('tea time ☕')];
    const rules = [{ title: 'Meditation' }, { title: 'Tea time' }];

    const out = reconcileHabitLogToRules(habitLog, rules);

    expect(out[0].habitTitle).toBe('meditation');
    expect(out[1].habitTitle).toBe('tea time');
  });

  it('handles the real-world spelling-preserving case (Read Mantra 🕉️)', () => {
    const out = reconcileHabitLogToRules(
      [log('read mantra 🕉️')],
      [{ title: 'Read Mantra' }],
    );
    expect(out[0].habitTitle).toBe(normalize('Read Mantra'));
  });

  it('re-attaches flag/keycap-emoji orphans (regional indicators, not Extended_Pictographic)', () => {
    const out = reconcileHabitLogToRules(
      [log('🇺🇸 spanish'), log('1️⃣ pushup')],
      [{ title: 'Spanish' }, { title: '1 Pushup' }],
    );
    expect(out[0].habitTitle).toBe('spanish');
    expect(out[1].habitTitle).toBe('1 pushup');
  });

  it('leaves logs already on a live rule key untouched (same reference)', () => {
    const habitLog = [log('yoga'), log('workout')];
    const rules = [{ title: 'Yoga' }, { title: 'Workout' }];

    const out = reconcileHabitLogToRules(habitLog, rules);

    // Nothing to fix → original array returned, idempotent.
    expect(out).toBe(habitLog);
  });

  it('is idempotent — a second pass changes nothing', () => {
    const rules = [{ title: 'Meditation' }];
    const once = reconcileHabitLogToRules([log('🧘 meditation')], rules);
    const twice = reconcileHabitLogToRules(once, rules);
    expect(twice).toBe(once);
    expect(twice[0].habitTitle).toBe('meditation');
  });

  it('does not relabel when no rule matches the stripped key (rule deleted)', () => {
    const habitLog = [log('🧘 meditation')];
    const out = reconcileHabitLogToRules(habitLog, [{ title: 'Workout' }]);
    expect(out[0].habitTitle).toBe('🧘 meditation');
  });

  it('refuses to guess on ambiguous stripped keys', () => {
    // Both "Run" and "🏃 Run" exist as live rules → the orphan stays put.
    const habitLog = [log('🏃‍♂️ run', 'a')];
    const rules = [{ title: 'Run' }, { title: '🏃 Run' }];
    const out = reconcileHabitLogToRules(habitLog, rules);
    expect(out[0].habitTitle).toBe('🏃‍♂️ run');
  });

  it('handles empty / malformed input safely', () => {
    expect(reconcileHabitLogToRules([], [{ title: 'x' }])).toEqual([]);
    expect(reconcileHabitLogToRules(null, null)).toEqual([]);
    expect(reconcileHabitLogToRules(undefined, [{ title: 'x' }])).toEqual([]);
    const onlyLogs = [log('🧘 meditation')];
    expect(reconcileHabitLogToRules(onlyLogs, [])).toBe(onlyLogs);
  });

  it('preserves all other entry fields when relabeling', () => {
    const entry = { id: '1', habitTitle: '🧘 meditation', dateKey: '2026-05-30', timestamp: 123, goalIds: ['p1'] };
    const out = reconcileHabitLogToRules([entry], [{ title: 'Meditation' }]);
    expect(out[0]).toEqual({ ...entry, habitTitle: 'meditation' });
  });
});


describe('reconcileTitleKeyedMap', () => {
  const rules = [{ title: 'Meditation' }];

  it('moves an emoji-orphaned scalar entry onto the live rule key', () => {
    expect(reconcileTitleKeyedMap({ '🧘 meditation': 30 }, rules)).toEqual({ meditation: 30 });
  });

  it('no-clobber: a live value under the target key wins, stale orphan dropped', () => {
    // streak rebuilt under the new title post-rename must not be overwritten
    expect(reconcileTitleKeyedMap({ '🧘 meditation': 30, meditation: 4 }, rules)).toEqual({ meditation: 4 });
  });

  it('leaves healthy live-keyed maps untouched (same reference)', () => {
    const m = { meditation: 5 };
    expect(reconcileTitleKeyedMap(m, rules)).toBe(m);
  });

  it('leaves ambiguous stripped keys alone (same reference)', () => {
    const ambRules = [{ title: 'Run' }, { title: '🏃 Run' }];
    const m = { '🏃 run': 9 };
    expect(reconcileTitleKeyedMap(m, ambRules)).toBe(m);
  });

  it('is idempotent', () => {
    const once = reconcileTitleKeyedMap({ '🧘 meditation': 30 }, rules);
    expect(reconcileTitleKeyedMap(once, rules)).toEqual({ meditation: 30 });
  });

  it('returns the source reference when there are no rules', () => {
    const m = { '🧘 meditation': 30 };
    expect(reconcileTitleKeyedMap(m, [])).toBe(m);
  });

  it('leaves an orphan with no matching rule untouched', () => {
    const m = { '🔥 nonexistent': 2 };
    expect(reconcileTitleKeyedMap(m, rules)).toBe(m);
  });
});
