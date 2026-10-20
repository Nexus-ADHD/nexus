import { describe, it, expect } from 'vitest';
import { selectTodayTaskRollup } from '../today-rollup';

// ───────────────────────────────────────────────────────────────────────
// Tests for the per-day exception filter on RecurringToDo materialization
// (Apple-Calendar-style "skip just today" without breaking the series).
// ───────────────────────────────────────────────────────────────────────

describe('selectTodayTaskRollup — per-day exceptions', () => {
  it('suppresses materialization on an excepted dateKey', () => {
    const todo = {
      id: 't1',
      title: 'Breakfast for the girls',
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6], // daily
      interval: 1,
      exceptions: ['2026-05-04'],
    };
    const out = selectTodayTaskRollup([todo], [], '2026-05-04');
    expect(out.items.find((i) => i.title === 'Breakfast for the girls')).toBeUndefined();
  });

  it('still fires on adjacent scheduled days when one day is excepted', () => {
    const todo = {
      id: 't1',
      title: 'Breakfast for the girls',
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      interval: 1,
      exceptions: ['2026-05-04'],
    };
    const next = selectTodayTaskRollup([todo], [], '2026-05-05');
    expect(next.items.some((i) => i.title === 'Breakfast for the girls')).toBe(true);
    const prev = selectTodayTaskRollup([todo], [], '2026-05-03');
    expect(prev.items.some((i) => i.title === 'Breakfast for the girls')).toBe(true);
  });

  it('treats missing/empty exceptions as no skips (legacy compatibility)', () => {
    // Pre-v15 rule (no exceptions field).
    const legacy = {
      id: 't1',
      title: 'Legacy daily',
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      interval: 1,
    };
    const out = selectTodayTaskRollup([legacy], [], '2026-05-04');
    expect(out.items.some((i) => i.title === 'Legacy daily')).toBe(true);
  });

  it('honors exceptions when combined with a biweekly interval', () => {
    // Mon-only biweekly anchored to a Monday two weeks ago. NOW = Mon
    // 2026-05-04. Anchor = 2026-04-20 (also a Monday). Weeks-diff = 2,
    // 2 % 2 === 0, so this Monday IS a scheduled day. Exception
    // suppresses it.
    const todo = {
      id: 't1',
      title: 'Biweekly Mon',
      daysOfWeek: [1],
      interval: 2,
      intervalAnchorDate: '2026-04-20',
      exceptions: ['2026-05-04'],
    };
    const out = selectTodayTaskRollup([todo], [], '2026-05-04');
    expect(out.items.some((i) => i.title === 'Biweekly Mon')).toBe(false);
    // Off-cycle Monday Apr 27 — should not appear regardless of exception.
    const offCycle = selectTodayTaskRollup([todo], [], '2026-04-27');
    expect(offCycle.items.some((i) => i.title === 'Biweekly Mon')).toBe(false);
    // Next on-cycle Monday May 18 — appears (no exception set there).
    const nextCycle = selectTodayTaskRollup([todo], [], '2026-05-18');
    expect(nextCycle.items.some((i) => i.title === 'Biweekly Mon')).toBe(true);
  });

  it('exception on an off-schedule day is a no-op', () => {
    // Tue/Thu rule (daysOfWeek [2, 4]). NOW = Mon 2026-05-04 — not
    // scheduled. An exception entry for Mon shouldn't change anything.
    const todo = {
      id: 't1',
      title: 'Tue/Thu only',
      daysOfWeek: [2, 4],
      interval: 1,
      exceptions: ['2026-05-04'],
    };
    const out = selectTodayTaskRollup([todo], [], '2026-05-04');
    expect(out.items.some((i) => i.title === 'Tue/Thu only')).toBe(false);
    // Tuesday May 5: still fires.
    const tue = selectTodayTaskRollup([todo], [], '2026-05-05');
    expect(tue.items.some((i) => i.title === 'Tue/Thu only')).toBe(true);
  });
});

describe('occursOn — date-only interval anchors parse LOCAL (Greptile P1 on #375)', () => {
  it('a Sunday date-only anchor stays in its own week west of UTC', () => {
    // Regression: `new Date('2026-08-02')` parses as UTC midnight = Saturday
    // evening in any west-of-UTC tz, moving the anchor Sunday back a week —
    // Home excluded a biweekly task the widget (local parsing) included.
    // 2026-08-02 is a Sunday; 2026-08-06 is the Thursday of the SAME week.
    const todo = {
      id: 't1',
      title: 'Meal prep',
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      interval: 2,
      intervalAnchorDate: '2026-08-02', // date-only, Sunday
    };
    expect(selectTodayTaskRollup([todo], [], '2026-08-06').total).toBe(1); // anchor week
    expect(selectTodayTaskRollup([todo], [], '2026-08-13').total).toBe(0); // off week
    expect(selectTodayTaskRollup([todo], [], '2026-08-20').total).toBe(1); // next on week
  });

  it('ISO datetime anchors keep the standard parser', () => {
    const todo = {
      id: 't1',
      title: 'Meal prep',
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      interval: 2,
      intervalAnchorDate: '2026-08-02T12:00:00',
    };
    expect(selectTodayTaskRollup([todo], [], '2026-08-06').total).toBe(1);
    expect(selectTodayTaskRollup([todo], [], '2026-08-13').total).toBe(0);
  });
});
