/**
 * NEX-309 — move one occurrence of a recurring to-do.
 *
 * A multi-state flow, so per LEARNINGS rule 3 every state is enumerated here in
 * commit 1 rather than discovered one review round at a time: refusals,
 * the happy path, the interaction with a biweekly interval, and undo.
 */
import { describe, expect, it } from 'vitest';
import {
  planMoveOccurrence,
  planUndoMoveOccurrence,
  type MovableRule,
  type DailyTasksMap,
} from '../move-recurring-occurrence';
import { selectTodayTaskRollup } from '../selectors/today-rollup';

// 2026-06-22 is a Monday; 06-23 Tue, 06-24 Wed.
const MON = '2026-06-22';
const TUE = '2026-06-23';
const WED = '2026-06-24';

let seq = 0;
const makeId = () => `detached-${++seq}`;

function weekdayRule(over: Partial<MovableRule> = {}): MovableRule {
  return {
    id: 'r1',
    title: 'Prep for the office',
    daysOfWeek: [1], // Mondays only
    interval: 1,
    intervalAnchorDate: MON,
    exceptions: [],
    ...over,
  };
}

describe('planMoveOccurrence — refusals', () => {
  it('refuses a same-day move', () => {
    const out = planMoveOccurrence(
      { recurringToDos: [weekdayRule()], dailyTasks: {}, ruleId: 'r1', fromDateKey: MON, toDateKey: MON },
      makeId,
    );
    expect(out).toEqual({ ok: false, reason: 'same-day' });
  });

  it('refuses when the rule does not exist', () => {
    const out = planMoveOccurrence(
      { recurringToDos: [weekdayRule()], dailyTasks: {}, ruleId: 'nope', fromDateKey: MON, toDateKey: TUE },
      makeId,
    );
    expect(out).toEqual({ ok: false, reason: 'rule-not-found' });
  });

  it('refuses to move an occurrence the user already completed', () => {
    // Moving it would delete the completed `-auto` record and recreate it
    // un-completed, silently revoking today's score credit (Law B).
    const daily: DailyTasksMap = {
      [MON]: [{ id: 'r1-auto', title: 'Prep for the office', completed: true }],
    };
    const out = planMoveOccurrence(
      { recurringToDos: [weekdayRule()], dailyTasks: daily, ruleId: 'r1', fromDateKey: MON, toDateKey: TUE },
      makeId,
    );
    expect(out).toEqual({ ok: false, reason: 'completed' });
  });

  it('allows the move when the materialized record exists but is NOT completed', () => {
    const daily: DailyTasksMap = {
      [MON]: [{ id: 'r1-auto', title: 'Prep for the office', completed: false }],
    };
    const out = planMoveOccurrence(
      { recurringToDos: [weekdayRule()], dailyTasks: daily, ruleId: 'r1', fromDateKey: MON, toDateKey: TUE },
      makeId,
    );
    expect(out.ok).toBe(true);
  });

  it('refuses when the rule already fires on the target day', () => {
    // Mon+Tue rule: moving Monday's onto Tuesday is not a move, and a detached
    // copy there would render twice in the app but once on the widget (the
    // NEX-306 id-vs-title dedup divergence).
    const out = planMoveOccurrence(
      {
        recurringToDos: [weekdayRule({ daysOfWeek: [1, 2] })],
        dailyTasks: {},
        ruleId: 'r1',
        fromDateKey: MON,
        toDateKey: TUE,
      },
      makeId,
    );
    expect(out).toEqual({ ok: false, reason: 'already-scheduled' });
  });

  it('ALLOWS the move when the target day is scheduled but already excepted', () => {
    // occursOn is false there, so nothing would render twice.
    const out = planMoveOccurrence(
      {
        recurringToDos: [weekdayRule({ daysOfWeek: [1, 2], exceptions: [TUE] })],
        dailyTasks: {},
        ruleId: 'r1',
        fromDateKey: MON,
        toDateKey: TUE,
      },
      makeId,
    );
    expect(out.ok).toBe(true);
  });

  it('respects the biweekly interval when judging the target day', () => {
    // Every-other-week Mon+Tue rule anchored this week: NEXT week's Tuesday is
    // an off week, so the rule does not fire there and the move is allowed.
    const NEXT_TUE = '2026-06-30';
    const out = planMoveOccurrence(
      {
        recurringToDos: [weekdayRule({ daysOfWeek: [1, 2], interval: 2, intervalAnchorDate: MON })],
        dailyTasks: {},
        ruleId: 'r1',
        fromDateKey: MON,
        toDateKey: NEXT_TUE,
      },
      makeId,
    );
    expect(out.ok).toBe(true);
  });
});

describe('planMoveOccurrence — the happy path', () => {
  it('excepts the source day, detaches onto the target, and drops the -auto row', () => {
    const daily: DailyTasksMap = {
      [MON]: [{ id: 'r1-auto', title: 'Prep for the office', completed: false }],
    };
    const out = planMoveOccurrence(
      {
        recurringToDos: [weekdayRule({ pillarId: 'm-1' })],
        dailyTasks: daily,
        ruleId: 'r1',
        fromDateKey: MON,
        toDateKey: TUE,
      },
      makeId,
    );
    if (!out.ok) throw new Error('expected ok');

    expect(out.recurringToDos[0].exceptions).toEqual([MON]);
    expect(out.dailyTasks[MON]).toEqual([]); // -auto row gone
    expect(out.dailyTasks[TUE]).toHaveLength(1);
    expect(out.dailyTasks[TUE][0]).toMatchObject({
      title: 'Prep for the office',
      completed: false,
      pillarId: 'm-1', // mandate link survives the detach
      movedFromRuleId: 'r1',
      movedFromDateKey: MON,
    });
    expect(out.dailyTasks[TUE][0].id).toBe(out.detachedId);
  });

  it('the rollup then shows it on the target day and NOT on the source day', () => {
    // End-to-end against the real selector — the point of the whole feature.
    const rules = [weekdayRule({ daysOfWeek: [1, 2, 3] })];
    const before = selectTodayTaskRollup(rules, [], MON);
    expect(before.items.map((i) => i.title)).toEqual(['Prep for the office']);

    const out = planMoveOccurrence(
      { recurringToDos: rules, dailyTasks: {}, ruleId: 'r1', fromDateKey: MON, toDateKey: '2026-06-25' },
      makeId,
    );
    if (!out.ok) throw new Error('expected ok');

    const afterSource = selectTodayTaskRollup(out.recurringToDos, out.dailyTasks[MON] ?? [], MON);
    expect(afterSource.items).toEqual([]);

    const THU = '2026-06-25';
    const afterTarget = selectTodayTaskRollup(out.recurringToDos, out.dailyTasks[THU] ?? [], THU);
    expect(afterTarget.items.map((i) => i.title)).toEqual(['Prep for the office']);
    expect(afterTarget.items).toHaveLength(1); // exactly one, never doubled
  });

  it('appends rather than clobbering existing tasks on the target day', () => {
    const daily: DailyTasksMap = { [TUE]: [{ id: 'other', title: 'Existing', completed: false }] };
    const out = planMoveOccurrence(
      { recurringToDos: [weekdayRule()], dailyTasks: daily, ruleId: 'r1', fromDateKey: MON, toDateKey: TUE },
      makeId,
    );
    if (!out.ok) throw new Error('expected ok');
    expect(out.dailyTasks[TUE].map((t) => t.title)).toEqual(['Existing', 'Prep for the office']);
  });

  it('does not double-add an exception that is already present', () => {
    const out = planMoveOccurrence(
      {
        recurringToDos: [weekdayRule({ exceptions: [MON] })],
        dailyTasks: {},
        ruleId: 'r1',
        fromDateKey: MON,
        toDateKey: TUE,
      },
      makeId,
    );
    if (!out.ok) throw new Error('expected ok');
    expect(out.recurringToDos[0].exceptions).toEqual([MON]);
  });

  it('does not mutate the inputs', () => {
    const rules = [weekdayRule()];
    const daily: DailyTasksMap = { [MON]: [{ id: 'r1-auto', title: 'x', completed: false }] };
    planMoveOccurrence(
      { recurringToDos: rules, dailyTasks: daily, ruleId: 'r1', fromDateKey: MON, toDateKey: TUE },
      makeId,
    );
    expect(rules[0].exceptions).toEqual([]);
    expect(daily[MON]).toHaveLength(1);
    expect(daily[TUE]).toBeUndefined();
  });

  it('tolerates garbage state without throwing', () => {
    expect(
      planMoveOccurrence(
        { recurringToDos: null, dailyTasks: null, ruleId: 'r1', fromDateKey: MON, toDateKey: TUE },
        makeId,
      ),
    ).toEqual({ ok: false, reason: 'rule-not-found' });
    expect(
      planMoveOccurrence(
        { recurringToDos: [weekdayRule()], dailyTasks: 'nope', ruleId: 'r1', fromDateKey: MON, toDateKey: TUE },
        makeId,
      ).ok,
    ).toBe(true);
  });
});

describe('planUndoMoveOccurrence', () => {
  it('is the exact inverse of a move', () => {
    const rules = [weekdayRule()];
    const moved = planMoveOccurrence(
      { recurringToDos: rules, dailyTasks: {}, ruleId: 'r1', fromDateKey: MON, toDateKey: TUE },
      makeId,
    );
    if (!moved.ok) throw new Error('expected ok');

    const undone = planUndoMoveOccurrence({
      recurringToDos: moved.recurringToDos,
      dailyTasks: moved.dailyTasks,
      ruleId: 'r1',
      fromDateKey: MON,
      toDateKey: TUE,
      detachedId: moved.detachedId,
    });

    expect(undone.recurringToDos[0].exceptions).toEqual([]);
    expect(undone.dailyTasks[TUE]).toEqual([]);
    // and the occurrence is visible on the source day again
    expect(selectTodayTaskRollup(undone.recurringToDos, [], MON).items).toHaveLength(1);
  });

  it('is idempotent — a double-tapped undo cannot corrupt state', () => {
    const moved = planMoveOccurrence(
      { recurringToDos: [weekdayRule()], dailyTasks: {}, ruleId: 'r1', fromDateKey: MON, toDateKey: TUE },
      makeId,
    );
    if (!moved.ok) throw new Error('expected ok');
    const args = {
      ruleId: 'r1',
      fromDateKey: MON,
      toDateKey: TUE,
      detachedId: moved.detachedId,
    };
    const once = planUndoMoveOccurrence({ ...args, recurringToDos: moved.recurringToDos, dailyTasks: moved.dailyTasks });
    const twice = planUndoMoveOccurrence({ ...args, recurringToDos: once.recurringToDos, dailyTasks: once.dailyTasks });
    expect(twice).toEqual(once);
  });

  it('leaves OTHER exceptions and OTHER tasks on the target day alone', () => {
    const rules = [weekdayRule({ exceptions: [WED] })];
    const daily: DailyTasksMap = { [TUE]: [{ id: 'keep', title: 'Existing', completed: false }] };
    const moved = planMoveOccurrence(
      { recurringToDos: rules, dailyTasks: daily, ruleId: 'r1', fromDateKey: MON, toDateKey: TUE },
      makeId,
    );
    if (!moved.ok) throw new Error('expected ok');
    const undone = planUndoMoveOccurrence({
      recurringToDos: moved.recurringToDos,
      dailyTasks: moved.dailyTasks,
      ruleId: 'r1',
      fromDateKey: MON,
      toDateKey: TUE,
      detachedId: moved.detachedId,
    });
    expect(undone.recurringToDos[0].exceptions).toEqual([WED]);
    expect(undone.dailyTasks[TUE].map((t) => t.id)).toEqual(['keep']);
  });
});

describe('the detached occurrence is independent of the series (Apple semantics)', () => {
  it('survives the series being deleted', () => {
    const moved = planMoveOccurrence(
      { recurringToDos: [weekdayRule()], dailyTasks: {}, ruleId: 'r1', fromDateKey: MON, toDateKey: TUE },
      makeId,
    );
    if (!moved.ok) throw new Error('expected ok');
    // series gone; the detached task is a plain one-off and still renders
    const afterDelete = selectTodayTaskRollup([], moved.dailyTasks[TUE], TUE);
    expect(afterDelete.items.map((i) => i.title)).toEqual(['Prep for the office']);
  });

  it('keeps its snapshot title when the series is renamed afterwards', () => {
    const rules = [weekdayRule()];
    const moved = planMoveOccurrence(
      { recurringToDos: rules, dailyTasks: {}, ruleId: 'r1', fromDateKey: MON, toDateKey: TUE },
      makeId,
    );
    if (!moved.ok) throw new Error('expected ok');
    const renamed = moved.recurringToDos.map((r) => ({ ...r, title: 'Something else' }));
    expect(selectTodayTaskRollup(renamed, moved.dailyTasks[TUE], TUE).items[0].title).toBe(
      'Prep for the office',
    );
  });
});

describe('describeMoveTarget (the Law A confirmation copy)', () => {
  it('names the day in the most locatable way', async () => {
    const { describeMoveTarget } = await import('../move-recurring-occurrence');
    expect(describeMoveTarget(MON, MON)).toBe('Today');
    expect(describeMoveTarget(TUE, MON)).toBe('Tomorrow');
    expect(describeMoveTarget(MON, TUE)).toBe('Yesterday');
    expect(describeMoveTarget('2026-06-25', MON)).toBe('Thursday'); // within the week
    expect(describeMoveTarget('2026-06-30', MON)).toBe('Jun 30'); // beyond it
    expect(describeMoveTarget('2026-07-04', MON)).toBe('Jul 4');
  });

  it('degrades instead of throwing on bad input', async () => {
    const { describeMoveTarget } = await import('../move-recurring-occurrence');
    expect(describeMoveTarget('', MON)).toBe('that day');
    expect(describeMoveTarget('garbage', MON)).toBe('garbage');
  });

  it('carries no banned punctuation (§18.1)', async () => {
    const { describeMoveTarget } = await import('../move-recurring-occurrence');
    for (const k of [MON, TUE, '2026-06-25', '2026-06-30']) {
      const label = describeMoveTarget(k, MON);
      expect(label).not.toMatch(/[—!]/);
    }
  });
});
